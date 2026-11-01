package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SettingsTransferTest {
    private val androidSettings: Map<String, Any?> = linkedMapOf(
        "display.timeFormat" to "24h",
        "terminal.connections" to """[{"id":"c1","url":"g2mirror://token@host:8737","enabled":true}]""",
        "display.uiFont2" to """{"kind":"ttf","file":"Roboto-Light.ttf","size":15}""",
        "navigate.homeAddress" to "[home] 1 Main St",
        "assistant.prompt" to "{ \"not\": \"compact\" }",
        "voice.enabled" to true,
        "flappy.highScore" to "18",
        "ratio" to 0.25,
        "count" to 42L,
        "notifications.sources" to """[{"packageName":"com.tailscale.ipn","showOnGlasses":true}]""",
        "deviceIdentity.pairedAtMs" to JsonNumber("1791678209651"),
        "deviceAddress.left" to "EC:D7:82:69:3C:CB",
        "onboarding.complete" to true,
        "evenhub:com.example.app:ls:state" to """{"level":3}""",
        "ios.settings.changeToken" to "bookkeeping",
    )

    @Test
    fun exportSplitsPortableAndPlatformSettingsAndExpandsJsonLosslessly() {
        val text = SettingsTransfer.export(androidSettings, "android", "0.8.3")
        val document = Json.parseObject(text)
        assertEquals(JsonNumber("2"), document["schema"])
        assertEquals("android", document["platform"])
        assertEquals("0.8.3", document["appVersion"])
        val settings = document["settings"].asObject()!!
        val local = document["platformSettings"].asObject()!!
        assertEquals(settings.keys.sorted(), settings.keys.toList())
        assertEquals(
            setOf("notifications.sources", "deviceIdentity.pairedAtMs", "deviceAddress.left", "onboarding.complete"),
            local.keys,
        )
        assertTrue("ios.settings.changeToken" !in settings && "ios.settings.changeToken" !in local)
        // Compact JSON becomes structure; anything that wouldn't round-trip exactly stays a string.
        assertEquals("g2mirror://token@host:8737", settings["terminal.connections"].asArray()!![0].asObject()!!["url"])
        assertEquals(JsonNumber("3"), settings["evenhub:com.example.app:ls:state"].asObject()!!["level"])
        assertEquals("[home] 1 Main St", settings["navigate.homeAddress"])
        assertEquals("{ \"not\": \"compact\" }", settings["assistant.prompt"])
        assertEquals(true, settings["voice.enabled"])
        assertEquals("18", settings["flappy.highScore"])
        assertEquals(JsonNumber("0.25"), settings["ratio"])
        assertEquals(JsonNumber("42"), settings["count"])
        assertEquals(JsonNumber("1791678209651"), local["deviceIdentity.pairedAtMs"])
    }

    @Test
    fun samePlatformImportRestoresEveryValueExactly() {
        val plan = SettingsTransfer.planImport(SettingsTransfer.export(androidSettings, "android"), "android")
        assertEquals("android", plan.sourcePlatform)
        assertTrue(plan.skipped.isEmpty())
        val expected = androidSettings - "ios.settings.changeToken"
        assertEquals(expected.keys, plan.values.keys)
        for ((key, value) in expected) {
            val want: Any? = when (value) {
                is Double -> JsonNumber.of(value)
                is Long -> JsonNumber(value.toString())
                else -> value
            }
            assertEquals(want, plan.values[key], key)
        }
    }

    @Test
    fun crossPlatformImportCarriesOnlyPortableSettings() {
        val plan = SettingsTransfer.planImport(SettingsTransfer.export(androidSettings, "android"), "ios")
        assertEquals(
            setOf("notifications.sources", "deviceIdentity.pairedAtMs", "deviceAddress.left", "onboarding.complete"),
            plan.skipped.toSet(),
        )
        assertEquals("24h", plan.values["display.timeFormat"])
        assertEquals(androidSettings["terminal.connections"], plan.values["terminal.connections"])
        assertTrue(plan.values.keys.none { SettingsTransfer.isPlatformLocal(it) })
    }

    @Test
    fun legacySchemaOneIsClassifiedAtImport() {
        val iosExport = """{"schema":1,"settings":{
            "ios.ble.peripheral.EC:D7:82:69:3C:CB":"{\"identifier\":\"8A2D\",\"role\":\"left\"}",
            "deviceAddress.left":"EC:D7:82:69:3C:CB",
            "integrations.evenhub.terminalId":"1429021a30db4586",
            "privacy.dataCollection":"full",
            "onboarding.complete":true}}"""
        val onAndroid = SettingsTransfer.planImport(iosExport, "android")
        assertEquals("ios", onAndroid.sourcePlatform)
        assertEquals(mapOf<String, Any>("privacy.dataCollection" to "full"), onAndroid.values)
        assertEquals(4, onAndroid.skipped.size)
        assertEquals(5, SettingsTransfer.planImport(iosExport, "ios").values.size)

        // scripts/config_document.py converts Android shared-preferences XML to this shape.
        val fromXml = """{"schema":1,"platform":"android","settings":{"deviceAddress.left":"AA","display.mode":"576x288"}}"""
        assertEquals(2, SettingsTransfer.planImport(fromXml, "android").values.size)
        assertEquals(listOf("deviceAddress.left"), SettingsTransfer.planImport(fromXml, "ios").skipped)
    }

    @Test
    fun handEditedDocumentsFollowTheirSections() {
        val edited = """{
            "schema": 2,
            "settings": { "launcher.folders": { "pinball": "Games" }, "music.lastApp": "kept" },
            "platformSettings": { "deviceAddress.left": "AA" }
        }"""
        val plan = SettingsTransfer.planImport(edited, "ios")
        assertNull(plan.sourcePlatform)
        // No platform: platformSettings never apply, settings always do, even a platform-local key.
        assertEquals(mapOf<String, Any>("launcher.folders" to """{"pinball":"Games"}""", "music.lastApp" to "kept"), plan.values)
        assertEquals(listOf("deviceAddress.left"), plan.skipped)
    }

    @Test
    fun malformedDocumentsAreRejected() {
        val invalid = listOf(
            "not json",
            "[]",
            """{"settings":{}}""",
            """{"schema":3,"settings":{}}""",
            """{"schema":2}""",
            """{"schema":2,"settings":[]}""",
            """{"schema":2,"settings":{"x":null}}""",
            """{"schema":2,"settings":{"":"empty name"}}""",
            """{"schema":2,"platform":7,"settings":{}}""",
            """{"schema":2,"platform":"ios","settings":{"x":"a"},"platformSettings":{"x":"b"}}""",
            """{"schema":2,"settings":{"x":"a","x":"b"}}""",
        )
        for (text in invalid) assertFailsWith<IllegalArgumentException>(text) { SettingsTransfer.planImport(text, "ios") }
        assertFailsWith<IllegalArgumentException> { SettingsTransfer.export(mapOf("x" to listOf("a")), "ios") }
    }

    @Test
    fun objectiveCBridgeUsesJsonText() {
        val document = SettingsTransfer.exportValues("""{"a":"b","on":true,"n":1.5,"ios.ble.peripheral.X":"{}"}""", "ios", null)!!
        assertNull(Json.parseObject(document)["appVersion"])
        val reply = Json.parseObject(SettingsTransfer.importPlan(document, "android"))
        assertEquals(true, reply["ok"])
        assertEquals(mapOf<String, Any?>("a" to "b", "n" to JsonNumber("1.5"), "on" to true), reply["settings"])
        assertEquals(listOf<Any?>("ios.ble.peripheral.X"), reply["skipped"])
        assertEquals("ios", reply["sourcePlatform"])
        val failure = Json.parseObject(SettingsTransfer.importPlan("""{"schema":9,"settings":{}}""", "ios"))
        assertEquals(false, failure["ok"])
        assertEquals("Unsupported config schema 9", failure["message"])
        assertNull(SettingsTransfer.exportValues("[]", "ios", null))
    }
}
