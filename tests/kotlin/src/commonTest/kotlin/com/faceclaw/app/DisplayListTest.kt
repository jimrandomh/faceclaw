package com.faceclaw.app

import kotlin.test.*
import kotlin.random.Random

class DisplayListTest {
    private fun hex(s: String) = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    @Test fun screenCopyPreservesOffsetsClippingPaddingAndAliasing() {
        val random = Random(42)
        val renderer = DisplayListRenderer(emptyMap())
        for (sourceWidth in listOf(1, 2, 3, 7, 8, 640)) for (destinationWidth in listOf(1, 2, 3, 7, 8, 640)) {
            for (shared in listOf(false, true)) for (shift in listOf(-3, 0, 2)) {
                val sourceHeight = random.nextInt(1, 5); val destinationHeight = random.nextInt(1, 5)
                val sourceOffset = random.nextInt(4); val destinationOffset = random.nextInt(4)
                val size = maxOf(sourceOffset + (sourceWidth + 1) / 2 * sourceHeight,
                    destinationOffset + (destinationWidth + 1) / 2 * destinationHeight) + 3
                val source = random.nextBytes(size)
                val destination = if (shared) source else random.nextBytes(size)
                val expectedSource = source.copyOf()
                val expectedDestination = if (shared) expectedSource else destination.copyOf()
                // Original per-pixel semantics, including cascading writes when
                // views alias and ignoring shiftX when reading the source.
                val referenceSource = DisplayListRenderer.Target(expectedSource, sourceWidth, sourceHeight, sourceOffset, 5)
                val referenceDestination = DisplayListRenderer.Target(expectedDestination, destinationWidth, destinationHeight, destinationOffset, shift)
                for (y in 0 until sourceHeight) for (x in 0 until sourceWidth)
                    referenceDestination.put(x, y, referenceSource.get(x, y))
                assertEquals(emptySet(), renderer.render(DrawProtocol.SCREEN,
                    DisplayListRenderer.Target(source, sourceWidth, sourceHeight, sourceOffset, 5),
                    DisplayListRenderer.Target(destination, destinationWidth, destinationHeight, destinationOffset, shift)))
                assertContentEquals(expectedDestination, destination, "$sourceWidth/$destinationWidth shared=$shared shift=$shift")
                assertContentEquals(expectedSource, source)
            }
        }
        val source = random.nextBytes(640 * 480 / 2)
        val destination = ByteArray(source.size)
        renderer.render(DrawProtocol.SCREEN, DisplayListRenderer.Target(source,640,480), DisplayListRenderer.Target(destination,640,480))
        assertContentEquals(source, destination)
    }
    @Test fun invalidGraphDoesNotCopyScreenIntoComposition() {
        val screen = hex("12345678"); val composition = hex("9abcdef0")
        val resources = mapOf(1 to DrawProtocol.displayList(listOf(byteArrayOf(99,0))))
        assertFails { DisplayListRenderer(resources).render(1, DisplayListRenderer.Target(screen,8,1), DisplayListRenderer.Target(composition,8,1)) }
        assertContentEquals(hex("9abcdef0"), composition)
    }
    @Test fun oddPixelsRawRleClippingFontsNestedListsAndLut() {
        val raw = DrawProtocol.rawImage(3, 3, hex("123045607890"))
        val font = ByteArray(197); font[0]=1; font[67]=193.toByte(); hex("0801011f").copyInto(font,193)
        val resources = mutableMapOf(10 to raw, 11 to hex("0802024f"), 12 to font)
        val nested = listOf(DrawProtocol.image(11, -1, 0), DrawProtocol.bbox(hex("0c000000"), 2, 1, 0, 1, 1, 10))
        resources[20]=DrawProtocol.displayList(nested)
        val calls = listOf(DrawProtocol.call(DRAW_OP_DISPLAY_LIST,DrawProtocol.word(20)), DrawProtocol.image(10,3,1),
            DrawProtocol.call(DRAW_OP_TEXT,hex("0c00070003000f0141")), DrawProtocol.lut(8,4,128))
        resources[21]=DrawProtocol.displayList(calls)
        // Like the C harness, seed composition with the screen: this list has no screen copy.
        val screen=hex("123456789abcdef0123456789abcdef0"); val output=screen.copyOf()
        val renderer=DisplayListRenderer(resources)
        assertEquals(setOf(10,11,12,20,21),renderer.render(21,DisplayListRenderer.Target(screen,8,4),DisplayListRenderer.Target(output,8,4)))
        // Shared with the C sanitizer harness: signed clipping, resource target override, font and LUT.
        assertContentEquals(hex("71122334755061700112233445534477"),output)
        val first=output.copyOf(); screen.copyInto(output); renderer.render(21,DisplayListRenderer.Target(screen,8,4),DisplayListRenderer.Target(output,8,4))
        assertContentEquals(first,output)
        assertContentEquals(hex("123456789abcdef0123456789abcdef0"),screen)
    }
    @Test fun rootListsComposeTheScreenCopyAndClearBeforeDepthShifts() {
        val screen = ByteArray(640 * 480 / 2) { (0x12 + it * 0x22).toByte() }
        val sourceTarget = DisplayListRenderer.Target(screen, 640, 480)
        // Without a copy, a root presents only what it draws.
        val empty = mapOf(1 to DrawProtocol.displayList(emptyList()))
        val composition = ByteArray(screen.size) { 0x55 }
        DisplayListRenderer(empty).render(1, sourceTarget, DisplayListRenderer.Target(composition, 640, 480))
        assertTrue(composition.all { it == 0x55.toByte() })
        for (depth in listOf(-64, -17, 0, 1, 32)) for (right in listOf(false, true)) {
            val resources = mapOf(1 to DrawProtocol.displayList(DrawProtocol.screenCopy(640, 480, depth)))
            val output = ByteArray(screen.size) { -1 }
            val target = DisplayListRenderer.Target(output, 640, 480)
            DisplayListRenderer(resources, rightLens = right).render(1, sourceTarget, target)
            val shift = DrawProtocol.depthOffset(depth, right)
            for (y in listOf(0, 479)) for (x in 0 until 640) {
                val sx = x - shift
                assertEquals(if (sx in 0 until 640) sourceTarget.get(sx, y) else 0, target.get(x, y), "depth=$depth right=$right x=$x")
            }
        }
        // Clear fills the whole resource target, padding included, and ignores depth.
        val raw = DrawProtocol.rawImage(3, 2, hex("1234ab12"))
        DisplayListRenderer(mapOf(5 to raw)).execute(DrawProtocol.sequence(listOf(DrawProtocol.clear(7, target = 5))),
            DisplayListRenderer.Target(ByteArray(1), 1, 1))
        assertContentEquals(DrawProtocol.rawImage(3, 2, hex("77777777")), raw)
        val rejected = DrawProtocol.call(DRAW_OP_CLEAR, hex("10"))
        assertFails { DisplayListRenderer(emptyMap()).execute(DrawProtocol.sequence(listOf(rejected)), DisplayListRenderer.Target(ByteArray(1), 1, 1)) }
    }
    @Test fun graphValidationPrecedesMutationAndCopyPreservesOverlap() {
        val screen=hex("12345678"); val target=DisplayListRenderer.Target(screen,8,1)
        val copy=DrawProtocol.call(DRAW_OP_RECT_COPY,hex("feff0000060001000200"))
        DisplayListRenderer(emptyMap()).execute(DrawProtocol.sequence(listOf(copy)),target)
        assertContentEquals(hex("12123456"),screen)
        // Revision 29: an animated source row scrolls a raw strip; source bounds are checked each frame.
        val strip=mapOf(9 to DrawProtocol.rawImage(2,4,hex("11223344")))
        val scroll=DrawProtocol.rectCopy(9,DrawValue.Integer(0),DrawValue.animate(0,2,100),2,2,DrawValue.Integer(0),DrawValue.Integer(0))
        for ((elapsed,rows) in listOf(0L to "1122",100L to "3344",500L to "3344")) {
            val window=DisplayListRenderer.Target(ByteArray(2),2,2)
            val renderer=DisplayListRenderer(strip)
            renderer.execute(DrawProtocol.sequence(listOf(scroll)),window,elapsedMs=elapsed)
            assertContentEquals(hex(rows),window.bytes); assertEquals(elapsed<100,renderer.animationPending)
        }
        val past=DrawProtocol.rectCopy(9,0,3,2,2,0,0)
        assertFails { DisplayListRenderer(strip).execute(DrawProtocol.sequence(listOf(past)),DisplayListRenderer.Target(ByteArray(2),2,2)) }
        val valid=DrawProtocol.bbox(hex("ffffffff"),4,0,0,8,1)
        assertFails { DisplayListRenderer(emptyMap()).execute(DrawProtocol.sequence(listOf(valid,byteArrayOf(99,0))),target) }
        assertContentEquals(hex("12123456"),screen)
        val cyclic=mapOf(1 to DrawProtocol.displayList(listOf(DrawProtocol.call(DRAW_OP_DISPLAY_LIST,DrawProtocol.word(2)))),
            2 to DrawProtocol.displayList(listOf(DrawProtocol.call(DRAW_OP_DISPLAY_LIST,DrawProtocol.word(1)))))
        assertFails { DisplayListRenderer(cyclic).render(1,target,target) }
    }
    @Test fun roundedRectsAndNestedOddNegativeDepthMatchFirmwareOnBothLenses() {
        val resources = mapOf(
            40 to hex("0404000200f00f0ff0"),
            41 to hex("0202000d0008020201010c0008000300040a0a000402022800050004001f"),
            42 to hex("02010005000702fd2900"))
        val screen = hex("012345601234560112345601234560122345601234560123345601234560123445601234560123455601234f60123456601234560123456001234560123456011234560123456012234560123456012334560123456012344560123456012345")
        val expected = listOf("01234560123456011aaaaaaaaaa56012aa45644444aa0123a4564444456a1234a564f44f564a2345a6444fff644a3456a4444456444a4560aa44456444aa56011aaaaaaaaaa56012234560123456012334560123456012344560123456012345", "012345601234560112aaaaaaaaaa60122aa56444445aa1233a5644444564a2344a644f44f644a3455a4444ff6444a4566a4444564444a5600aa44564444aa60112aaaaaaaaaa6012234560123456012334560123456012344560123456012345")
        for (right in listOf(false, true)) {
            val output = screen.copyOf() // the shared vector's list has no screen copy
            DisplayListRenderer(resources, rightLens = right).render(42, DisplayListRenderer.Target(screen,16,12), DisplayListRenderer.Target(output,16,12))
            assertContentEquals(hex(expected[if(right) 1 else 0]), output)
        }
        for (depth in -128..127) {
            assertEquals(kotlin.math.floor(depth / 2.0).toInt(), DrawProtocol.depthOffset(depth, false))
            assertEquals(-kotlin.math.floor((depth + 1) / 2.0).toInt(), DrawProtocol.depthOffset(depth, true))
        }
    }
    @Test fun roundedFillPreservesBrighterTextAndDepthClipsWithoutNibbleDamage() {
        val pixels = ByteArray(32) { 0x11 }; pixels[13] = 0xf1.toByte()
        val target = DisplayListRenderer.Target(pixels,8,8)
        val fill = DrawProtocol.roundedRect(-1,0,8,8,2,6,16,2)
        DisplayListRenderer(emptyMap()).execute(DrawProtocol.sequence(listOf(fill)),target)
        assertEquals(15,target.get(2,3)); assertEquals(6,target.get(3,3)); assertEquals(1,target.get(0,0))
        val bbox = DrawProtocol.call(DRAW_OP_BOUNDING_BOX,hex("00000002010f10"),depth=-1)
        DisplayListRenderer(emptyMap()).execute(DrawProtocol.sequence(listOf(bbox)),target)
        assertEquals(15,target.get(0,0));assertEquals(1,target.get(7,0))
        val before=pixels.copyOf()
        assertFails { DisplayListRenderer(emptyMap()).execute(DrawProtocol.sequence(listOf(byteArrayOf(8,2))),target) }
        assertContentEquals(before,pixels)
    }
    @Test fun selectedMenuResourcesStayOutOfScreenAndReplayAtDepthTwo() {
        val planner=ScenePlanner(ResourceCacheState()); val left=Glasses(); val right=Glasses(true)
        val app=ByteArray(640*480/2) { 0x11 }
        fun row(x:Int) = MenuSelection(x,8,8,4,1,4,9,2,hex("00ff0000000000000000000000000000"))
        val scene=ShellScene(emptyList(),listOf(row(10)))
        val first=planner.plan(app,640,480,null,scene,1);left.apply(first.commands);right.apply(first.commands)
        assertContentEquals(app,left.screen);assertContentEquals(app,right.screen)
        val l=DisplayListRenderer.Target(left.composition,640,480);val r=DisplayListRenderer.Target(right.composition,640,480)
        assertEquals(15,l.get(13,8));assertEquals(15,r.get(11,8));assertEquals(1,l.get(9,8))
        val moved=planner.plan(app,640,480,null,ShellScene(emptyList(),listOf(row(20))),1)
        assertFalse(moved.commands.any { it[0].toInt()==26 || it[0].toInt()==29 })
        left.apply(moved.commands);assertContentEquals(app,left.screen)
        left.apply(planner.plan(app,640,480,null,ShellScene.EMPTY,1).commands)
        assertContentEquals(app,left.composition)
    }
    @Test fun contextMenusAndSidebarDepthReplayOnBothLensesWithoutBakedCopies() {
        fun record(kind: Int, x: Int, y: Int, w: Int, h: Int, depth: Int, gray: ByteArray): MenuSelection {
            val bytes = DrawProtocol.word(x) + DrawProtocol.word(y) + DrawProtocol.word(w) + DrawProtocol.word(h) +
                DrawProtocol.word(0) + byteArrayOf(16, 48, depth.toByte()) + DrawProtocol.word(0) + gray
            return MenuSelection.read(ArrayByteReader(bytes), kind)
        }
        val menu = record(5, 10, 10, 8, 8, 4, ByteArray(64) { if (it == 0) 0 else 1 })
        val selected = record(3, 12, 12, 4, 2, 6, ByteArray(8) { -1 })
        val icon = record(4, 30, 10, 2, 2, -2, ByteArray(4) { -1 })
        val app = ByteArray(640 * 480 / 2) { 0x66 }
        val planner = ScenePlanner(ResourceCacheState())
        val scene = ShellScene(emptyList(), listOf(menu, selected, icon))
        val plan = planner.plan(app, 640, 480, null, scene, 1)
        for (right in listOf(false, true)) {
            val glasses = Glasses(right); glasses.apply(plan.commands)
            assertContentEquals(app, glasses.screen)
            val output = DisplayListRenderer.Target(glasses.composition,640,480)
            val shift = if (right) -2 else 2
            assertEquals(6, output.get(10 + shift,10)) // transparent corner
            assertEquals(0, output.get(11 + shift,10)) // opaque black stays opaque
            assertEquals(15, output.get(12 + (if (right) -3 else 3),12))
            assertEquals(15, output.get(30 + (if (right) 1 else -1),10))
            assertEquals(6, output.get(if (right) 30 else 31,10)) // no unshifted icon
            val preview = scene.preview(ByteArray(640*480) { 96 },640,480,right)
            assertContentEquals(glasses.composition, BmpUtil.pack4bppFromGray8(preview,640,480))
        }
        // The shell uses an independently owned surface with its own depth.
        val shell = ShellScene(listOf(ShellScene.Layer(1,10,10,8,8,256,ByteArray(32),listOf(selected),4)))
        val left = shell.preview(ByteArray(640*480) { 96 },640,480)
        val right = shell.preview(ByteArray(640*480) { 96 },640,480,true)
        assertEquals(0,left[10*640+12].toInt()); assertEquals(96,left[10*640+10].toInt())
        assertEquals(0,right[10*640+8].toInt()); assertEquals(96,right[10*640+16].toInt())
    }

    private class Glasses(val right: Boolean = false) {
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
                26 -> DisplayListRenderer(resources, rightLens = right).execute(b.copyOfRange(1,b.size),DisplayListRenderer.Target(screen,640,480))
                27 -> root=DrawProtocol.u16(b,1)
                28 -> DisplayListRenderer(resources, rightLens = right).render(root,DisplayListRenderer.Target(screen,640,480),DisplayListRenderer.Target(composition,640,480))
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
    @Test fun fullScreenSurfaceDepthShiftsThePresentedScreenPerLens() {
        val c = SurfaceCompositor()
        c.configureScreen(640, 480)
        c.configureSurface("app", 0, 0, 640, 480, 0, 0)
        c.configureSurface("glance", 0, 0, 640, 480, 900, 0)
        val board = ByteArray(640 * 480) { if (it % 640 in 100 until 110) 255.toByte() else 0 }
        c.submitSurface("glance", ArrayByteReader(board), 0, 0, 640, 480, "board")
        c.setSurfaceDepth("glance", 32)
        assertEquals(32, c.composite().shellScene.screenDepth)
        // Only the topmost visible surface counts, and only when it opaquely covers the screen.
        c.configureSurface("partial", 0, 0, 10, 10, 950, 0)
        assertEquals(0, c.composite().shellScene.screenDepth)
        c.setSurfaceVisible("partial", false)
        c.setSurfaceVisible("glance", false)
        assertEquals(0, c.composite().shellScene.screenDepth)
        c.setSurfaceVisible("glance", true)
        val composite = c.composite()
        val screen = BmpUtil.pack4bppFromGray8(composite.screenGray, 640, 480)
        for (right in listOf(false, true)) {
            val glasses = Glasses(right)
            glasses.composition.fill(-1) // stale pixels from an earlier frame
            glasses.apply(ScenePlanner(ResourceCacheState()).plan(screen, 640, 480, null, composite.shellScene, 1).commands)
            assertContentEquals(screen, glasses.screen)
            val output = DisplayListRenderer.Target(glasses.composition, 640, 480)
            val shift = if (right) -16 else 16
            assertEquals(15, output.get(100 + shift, 0)); assertEquals(0, output.get(99 + shift, 0))
            assertEquals(15, output.get(109 + shift, 479)); assertEquals(0, output.get(110 + shift, 479))
            assertEquals(0, output.get(if (right) 639 else 0, 240)) // cleared, not stale
        }
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
