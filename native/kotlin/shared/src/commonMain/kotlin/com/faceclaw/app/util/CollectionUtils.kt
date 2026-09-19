package com.faceclaw.app

import kotlin.jvm.JvmStatic

class CollectionUtils {
    companion object {
        @JvmStatic
        fun singletonList(value: ByteArray): MutableList<ByteArray> {
            var list: MutableList<ByteArray> = ArrayList(1)
            list.add(value)
            return list
        }

        @JvmStatic
        fun listOf(a: ByteArray, b: ByteArray): MutableList<ByteArray> {
            var list: MutableList<ByteArray> = ArrayList(2)
            list.add(a)
            list.add(b)
            return list
        }

        @JvmStatic
        fun listOf(a: ByteArray, b: ByteArray, c: ByteArray): MutableList<ByteArray> {
            var list: MutableList<ByteArray> = ArrayList(3)
            list.add(a)
            list.add(b)
            list.add(c)
            return list
        }
    }
}
