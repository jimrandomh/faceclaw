package com.faceclaw.app

import android.content.ContentUris
import android.content.Context
import android.database.Cursor
import android.provider.CalendarContract
import android.util.Log

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

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

        private val PROJECTION = arrayOf(
            CalendarContract.Instances.EVENT_ID,
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END,
            CalendarContract.Instances.ALL_DAY,
            CalendarContract.Instances.EVENT_LOCATION,
            CalendarContract.Instances.CALENDAR_DISPLAY_NAME,
        )

        /**
         * JSON array of upcoming events starting from now through now+windowMs,
         * ordered by start time, capped at maxEvents. Each element carries id,
         * title, startMs, endMs, allDay, location, and calendarName.
         */
        @JvmStatic
        fun getUpcomingEventsJson(context: Context?, maxEvents: Int, windowMs: Long): String {
            if (context == null || maxEvents <= 0) {
                return "[]"
            }
            val now = System.currentTimeMillis()
            val end = now + Math.max(0L, windowMs)
            val limit = Math.min(200, maxEvents)

            val builder = CalendarContract.Instances.CONTENT_URI.buildUpon()
            ContentUris.appendId(builder, now)
            ContentUris.appendId(builder, end)
            val uri = builder.build()

            val out = JSONArray()
            var cursor: Cursor? = null
            try {
                cursor = context.contentResolver.query(
                    uri,
                    PROJECTION,
                    null,
                    null,
                    CalendarContract.Instances.BEGIN + " ASC")
                if (cursor != null) {
                    while (cursor.moveToNext() && out.length() < limit) {
                        try {
                            out.put(buildEventJson(cursor))
                        } catch (e: JSONException) {
                            Log.w(TAG, "failed to serialize calendar event", e)
                        }
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
            return out.toString()
        }

        @Throws(JSONException::class)
        private fun buildEventJson(cursor: Cursor): JSONObject {
            val event = JSONObject()
            event.put("id", cursor.getLong(0))
            event.put("title", if (cursor.isNull(1)) "" else cursor.getString(1))
            event.put("startMs", cursor.getLong(2))
            event.put("endMs", cursor.getLong(3))
            event.put("allDay", cursor.getInt(4) != 0)
            event.put("location", if (cursor.isNull(5)) "" else cursor.getString(5))
            event.put("calendarName", if (cursor.isNull(6)) "" else cursor.getString(6))
            return event
        }
    }
}
