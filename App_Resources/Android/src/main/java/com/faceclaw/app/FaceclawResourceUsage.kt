package com.faceclaw.app

import android.os.Debug
import android.os.Process
import android.os.SystemClock

import java.io.BufferedReader
import java.io.FileReader
import java.io.IOException

/** Lightweight process counters for the on-glasses resource-usage monitor. */
class FaceclawResourceUsage private constructor() {
    companion object {
        /**
         * Returns elapsedMs, processCpuMs, rssKb, nativeHeapKb, javaHeapKb,
         * javaHeapCommittedKb, and threadCount. Reading /proc/self/status avoids
         * the considerably heavier full Debug.MemoryInfo/PSS collection once per
         * second while still reporting the RSS that Android records at exit.
         */
        @JvmStatic
        fun sample(): LongArray {
            val status = readProcessStatus()
            val runtime = Runtime.getRuntime()
            val javaUsedBytes = runtime.totalMemory() - runtime.freeMemory()
            return longArrayOf(
                SystemClock.elapsedRealtime(),
                Process.getElapsedCpuTime(),
                status[0],
                Debug.getNativeHeapAllocatedSize() / 1024L,
                javaUsedBytes / 1024L,
                runtime.totalMemory() / 1024L,
                status[1],
            )
        }

        /** Returns {VmRSS in KiB, thread count}; unavailable values are zero. */
        private fun readProcessStatus(): LongArray {
            var rssKb = 0L
            var threadCount = 0L
            try {
                BufferedReader(FileReader("/proc/self/status")).use { reader ->
                    var line: String?
                    while (reader.readLine().also { line = it } != null) {
                        val current = line!!
                        if (current.startsWith("VmRSS:")) {
                            rssKb = firstNumber(current)
                        } else if (current.startsWith("Threads:")) {
                            threadCount = firstNumber(current)
                        }
                        if (rssKb > 0 && threadCount > 0) break
                    }
                }
            } catch (ignored: IOException) {
                // The graph remains useful with the runtime heap counters alone.
            }
            return longArrayOf(rssKb, threadCount)
        }

        private fun firstNumber(line: String): Long {
            var start = 0
            while (start < line.length && !Character.isDigit(line[start])) start++
            var end = start
            while (end < line.length && Character.isDigit(line[end])) end++
            if (start == end) return 0
            return try {
                line.substring(start, end).toLong()
            } catch (ignored: NumberFormatException) {
                0
            }
        }
    }
}
