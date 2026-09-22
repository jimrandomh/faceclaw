package com.faceclaw.app

import kotlin.test.*

class DisplayListTest {
    private fun hex(s: String) = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    @Test fun oddPixelsRawRleClippingFontsNestedListsAndLut() {
        val raw = DrawProtocol.rawImage(3, 3, hex("123045607890"))
        val font = ByteArray(197); font[0]=1; font[67]=193.toByte(); hex("0801011f").copyInto(font,193)
        val resources = mutableMapOf(10 to raw, 11 to hex("0802024f"), 12 to font)
        val nested = listOf(DrawProtocol.image(11, -1, 0), DrawProtocol.bbox(hex("0c000000"), 2, 1, 0, 1, 1, 10))
        resources[20]=DrawProtocol.displayList(nested)
        val calls = listOf(DrawProtocol.call(7,DrawProtocol.word(20)), DrawProtocol.image(10,3,1),
            DrawProtocol.call(5,hex("0c00070003000f0141")), DrawProtocol.lut(8,4,128))
        resources[21]=DrawProtocol.displayList(calls)
        val screen=hex("123456789abcdef0123456789abcdef0"); val output=ByteArray(16)
        val renderer=DisplayListRenderer(resources)
        assertEquals(setOf(10,11,12,20,21),renderer.render(21,DisplayListRenderer.Target(screen,8,4),DisplayListRenderer.Target(output,8,4)))
        // Shared with the C sanitizer harness: signed clipping, resource target override, font and LUT.
        assertContentEquals(hex("71122334755061700112233445534477"),output)
        val first=output.copyOf(); renderer.render(21,DisplayListRenderer.Target(screen,8,4),DisplayListRenderer.Target(output,8,4))
        assertContentEquals(first,output)
        assertContentEquals(hex("123456789abcdef0123456789abcdef0"),screen)
    }
    @Test fun graphValidationPrecedesMutationAndCopyPreservesOverlap() {
        val screen=hex("12345678"); val target=DisplayListRenderer.Target(screen,8,1)
        val copy=DrawProtocol.call(2,hex("feff000000000600010002000000"))
        DisplayListRenderer(emptyMap()).execute(DrawProtocol.sequence(listOf(copy)),target)
        assertContentEquals(hex("12123456"),screen)
        val valid=DrawProtocol.bbox(hex("ffffffff"),4,0,0,8,1)
        assertFails { DisplayListRenderer(emptyMap()).execute(DrawProtocol.sequence(listOf(valid,byteArrayOf(99,0))),target) }
        assertContentEquals(hex("12123456"),screen)
        val cyclic=mapOf(1 to DrawProtocol.displayList(listOf(DrawProtocol.call(7,DrawProtocol.word(2)))),
            2 to DrawProtocol.displayList(listOf(DrawProtocol.call(7,DrawProtocol.word(1)))))
        assertFails { DisplayListRenderer(cyclic).render(1,target,target) }
    }
    private class Glasses {
        val resources=mutableMapOf<Int,ByteArray>(); val screen=ByteArray(640*480/2);val composition=ByteArray(screen.size)
        var root=65535
        fun apply(commands: List<ByteArray>) {
            for(b in commands) when(b[0].toInt()) {
                21 -> { var p=3;repeat(DrawProtocol.u16(b,1)) {
                    val id=DrawProtocol.u16(b,p); val total=DrawProtocol.u16(b,p+2) or (DrawProtocol.u16(b,p+4) shl 16)
                    val offset=DrawProtocol.u16(b,p+6);val n=DrawProtocol.u16(b,p+8)
                    b.copyInto(resources.getOrPut(id){ByteArray(total)},offset,p+10,p+10+n);p+=10+n
                } }
                22 -> repeat(DrawProtocol.u16(b,1)) { resources.remove(DrawProtocol.u16(b,3+it*2)) }
                29 -> repeat(DrawProtocol.u16(b,1)) { val p=3+it*6;resources.getOrPut(DrawProtocol.u16(b,p)) { DrawProtocol.rawImage(DrawProtocol.u16(b,p+2),DrawProtocol.u16(b,p+4)) } }
                26 -> DisplayListRenderer(resources).execute(b.copyOfRange(1,b.size),DisplayListRenderer.Target(screen,640,480))
                27 -> root=DrawProtocol.u16(b,1)
                28 -> DisplayListRenderer(resources).render(root,DisplayListRenderer.Target(screen,640,480),DisplayListRenderer.Target(composition,640,480))
                else -> error("legacy command ${b[0]}")
            }
        }
    }
    @Test fun persistentShellUpdatesDoNotPolluteScreenAndClosingRevealsCurrentApp() {
        val cache=ResourceCacheState();val planner=ScenePlanner(cache);val glasses=Glasses()
        val app=ByteArray(640*480/2){0x99.toByte()}
        val overlay=ShellScene(listOf(ShellScene.Layer(1,0,0,3,3,128,hex("fff0fff0fff0"))))
        val first=planner.plan(app,640,480,null,overlay,1);glasses.apply(first.commands)
        assertContentEquals(app,glasses.screen);assertEquals(255,glasses.composition[0].toInt() and 255)
        assertEquals(0x44,glasses.composition[100].toInt() and 255)
        val changed=ShellScene(listOf(ShellScene.Layer(1,0,0,3,3,128,hex("111011101110"))))
        val repaint=planner.plan(app,640,480,null,changed,1)
        assertFalse(repaint.commands.any { it[0].toInt() in listOf(21,22,29) })
        glasses.apply(repaint.commands);assertContentEquals(app,glasses.screen)
        val newer=app.copyOf();newer[0]=0x22
        glasses.apply(planner.plan(newer,640,480,null,changed,1).commands)
        glasses.apply(planner.plan(newer,640,480,null,ShellScene.EMPTY,1).commands)
        assertContentEquals(newer,glasses.composition)
        cache.reset();val reconnect=planner.plan(newer,640,480,null,changed,1)
        assertTrue(reconnect.commands.any { it[0].toInt()==29 });glasses.apply(reconnect.commands)
        assertContentEquals(newer,glasses.screen)
    }
    @Test fun noisyFramesRemainBoundedAndResourceBudgetIs192KiB() {
        val cache=ResourceCacheState();val planner=ScenePlanner(cache);val glasses=Glasses()
        val app=ByteArray(640*480/2){(it*37).toByte()}
        val plan=planner.plan(app,640,480,null,ShellScene.EMPTY,1)
        assertTrue(plan.commands.all { it.size<=65535 });glasses.apply(plan.commands)
        assertContentEquals(app,glasses.screen);assertContentEquals(app,glasses.composition)
        assertEquals(196608,ResourceCacheState.CACHE_SIZE)
    }
}
