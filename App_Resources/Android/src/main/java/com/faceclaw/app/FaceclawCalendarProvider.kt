package com.faceclaw.app

import android.content.ContentUris
import android.content.Context
import android.database.Cursor
import android.provider.CalendarContract
import android.util.Log

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

import java.util.Calendar
import java.util.TimeZone

/**
 * Reads upcoming events from the Android Calendar provider for the Calendar
 * app. Queries the Instances table (rather than Events) so that recurring
 * events are expanded into concrete occurrences within the requested window.
 * Requires the READ_CALENDAR runtime permission; without it the content
 * resolver throws SecurityException and this returns an empty array.
 */
class FaceclawCalendarProvider private constructor() {
    companion object {
        private const val TAG = "FaceclawCalendar"
        private const val DAY_MS = 24L * 60 * 60 * 1000

        private val PROJECTION = arrayOf(
            CalendarContract.Instances.EVENT_ID,
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END,
            CalendarContract.Instances.ALL_DAY,
            CalendarContract.Instances.EVENT_LOCATION,
            CalendarContract.Instances.CALENDAR_DISPLAY_NAME,
        )

        private class Event(
            val id: Long,
            val title: String,
            val startMs: Long,
            val endMs: Long,
            val allDay: Boolean,
            val location: String,
            val calendarName: String,
        )

        /**
         * JSON array of events that haven't ended yet and start before
         * now+windowMs, ordered by start time, capped at maxEvents. Each
         * element carries id, title, startMs, endMs, allDay, location, and
         * calendarName. All-day events are reported as local-midnight
         * boundaries (matching EventKit on iOS), not the UTC-midnight
         * boundaries the provider stores them as.
         */
        @JvmStatic
        fun getUpcomingEventsJson(context: Context?, maxEvents: Int, windowMs: Long): String {
            if (context == null || maxEvents <= 0) {
                return "[]"
            }
            val now = System.currentTimeMillis()
            val end = now + Math.max(0L, windowMs)
            val limit = Math.min(200, maxEvents)

            // The provider matches all-day instances by their UTC-midnight
            // bounds, which can be up to a day away from the local day they
            // represent; widen the query and filter after converting.
            val builder = CalendarContract.Instances.CONTENT_URI.buildUpon()
            ContentUris.appendId(builder, now - DAY_MS)
            ContentUris.appendId(builder, end + DAY_MS)
            val uri = builder.build()

            val events = ArrayList<Event>()
            var cursor: Cursor? = null
            try {
                cursor = context.contentResolver.query(
                    uri,
                    PROJECTION,
                    null,
                    null,
                    CalendarContract.Instances.BEGIN + " ASC")
                if (cursor != null) {
                    val utc = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
                    val local = Calendar.getInstance()
                    // Rows arrive in raw-BEGIN order, but converting all-day
                    // events moves them by less than a day. Once `limit`
                    // events are kept, nothing starting after the latest of
                    // them can make the cut, and no row whose raw BEGIN is a
                    // day past that can start before it.
                    var cutoff = Long.MAX_VALUE
                    while (cursor.moveToNext()) {
                        if (cutoff != Long.MAX_VALUE && cursor.getLong(2) - DAY_MS > cutoff) break
                        val event = readEvent(cursor, utc, local)
                        if (event.endMs <= now || event.startMs > end || event.startMs > cutoff) continue
                        events.add(event)
                        if (events.size == limit) cutoff = events.maxOf { it.startMs }
                    }
                }
            } catch (e: SecurityException) {
                Log.w(TAG, "calendar access denied while reading events", e)
                return "[]"
            } catch (t: Throwable) {
                Log.w(TAG, "failed to read calendar events", t)
                return "[]"
            } finally {
                cursor?.close()
            }

            events.sortBy { it.startMs }
            val out = JSONArray()
            for (event in events.take(limit)) {
                try {
                    out.put(buildEventJson(event))
                } catch (e: JSONException) {
                    Log.w(TAG, "failed to serialize calendar event", e)
                }
            }
            return out.toString()
        }

        private fun readEvent(cursor: Cursor, utc: Calendar, local: Calendar): Event {
            val allDay = cursor.getInt(4) != 0
            var startMs = cursor.getLong(2)
            var endMs = cursor.getLong(3)
            if (allDay) {
                startMs = utcMidnightToLocal(startMs, utc, local)
                endMs = utcMidnightToLocal(endMs, utc, local)
            }
            return Event(
                id = cursor.getLong(0),
                title = if (cursor.isNull(1)) "" else cursor.getString(1),
                startMs = startMs,
                endMs = endMs,
                allDay = allDay,
                location = if (cursor.isNull(5)) "" else cursor.getString(5),
                calendarName = if (cursor.isNull(6)) "" else cursor.getString(6),
            )
        }

        /**
         * All-day events are stored as UTC midnights (CalendarContract
         * requires EVENT_TIMEZONE=UTC for them); re-anchor that calendar
         * date to midnight in the device's timezone.
         */
        private fun utcMidnightToLocal(utcMs: Long, utc: Calendar, local: Calendar): Long {
            utc.timeInMillis = utcMs
            local.timeZone = TimeZone.getDefault()
            local.clear()
            local.set(utc.get(Calendar.YEAR), utc.get(Calendar.MONTH), utc.get(Calendar.DAY_OF_MONTH))
            return local.timeInMillis
        }

        @Throws(JSONException::class)
        private fun buildEventJson(event: Event): JSONObject {
            val json = JSONObject()
            json.put("id", event.id)
            json.put("title", event.title)
            json.put("startMs", event.startMs)
            json.put("endMs", event.endMs)
            json.put("allDay", event.allDay)
            json.put("location", event.location)
            json.put("calendarName", event.calendarName)
            return json
        }
    }
}
