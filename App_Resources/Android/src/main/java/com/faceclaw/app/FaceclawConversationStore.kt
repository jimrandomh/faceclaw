package com.faceclaw.app

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.util.Base64
import android.util.Log

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.ArrayList

/**
 * Persistent store for caption sessions, transcript segments, and speaker
 * voice profiles, backing the Microphones app and its phone-side review UI.
 * All complex values cross the JS bridge as JSON strings; voice-print
 * embeddings are float32 LE blobs, exposed as base64.
 */
class FaceclawConversationStore private constructor(context: Context) : SQLiteOpenHelper(context, DB_NAME, null, DB_VERSION) {
    companion object {
        private const val TAG = "FaceclawConvStore"
        private const val DB_NAME = "faceclaw-conversations.db"
        private const val DB_VERSION = 2

        private var instance: FaceclawConversationStore? = null

        @JvmStatic
        @Synchronized
        fun getInstance(context: Context): FaceclawConversationStore {
            if (instance == null) {
                instance = FaceclawConversationStore(context.applicationContext)
            }
            return instance!!
        }

        @Throws(JSONException::class)
        private fun putOptString(values: ContentValues, s: JSONObject, jsonKey: String, column: String) {
            if (s.has(jsonKey) && !s.isNull(jsonKey)) {
                values.put(column, s.getString(jsonKey))
            }
        }

        // ---- blob helpers ----

        private fun blobToFloats(blob: ByteArray?): FloatArray? {
            if (blob == null || blob.size < 4 || blob.size % 4 != 0) {
                return null
            }
            val buffer = ByteBuffer.wrap(blob).order(ByteOrder.LITTLE_ENDIAN)
            val out = FloatArray(blob.size / 4)
            for (i in out.indices) {
                out[i] = buffer.getFloat()
            }
            return out
        }

        private fun floatsToBlob(values: FloatArray): ByteArray {
            val buffer = ByteBuffer.allocate(values.size * 4).order(ByteOrder.LITTLE_ENDIAN)
            for (v in values) {
                buffer.putFloat(v)
            }
            return buffer.array()
        }

        private fun l2NormalizeInPlace(v: FloatArray) {
            var sum = 0.0
            for (x in v) {
                sum += x.toDouble() * x
            }
            val norm = Math.sqrt(sum)
            if (norm <= 0) {
                return
            }
            for (i in v.indices) {
                v[i] = (v[i] / norm).toFloat()
            }
        }
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE speakers ("
            + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
            + "name TEXT NOT NULL,"
            + "color TEXT NOT NULL DEFAULT '#4FC3F7',"
            + "is_wearer INTEGER NOT NULL DEFAULT 0,"
            + "embedding BLOB,"
            + "embedding_count INTEGER NOT NULL DEFAULT 0,"
            + "created_at INTEGER NOT NULL,"
            + "last_heard_at INTEGER,"
            + "tag TEXT,"
            + "last_recap TEXT,"
            + "action_items TEXT,"
            + "facts TEXT,"
            + "insights_updated_at INTEGER,"
            + "insights_session_id INTEGER)")
        db.execSQL("CREATE TABLE sessions ("
            + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
            + "started_at INTEGER NOT NULL,"
            + "ended_at INTEGER,"
            + "title TEXT,"
            + "audio_path TEXT,"
            + "audio_codec TEXT,"
            + "avg_sentiment REAL,"
            + "segment_count INTEGER NOT NULL DEFAULT 0)")
        db.execSQL("CREATE TABLE segments ("
            + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
            + "session_id INTEGER NOT NULL,"
            + "speaker_id INTEGER,"
            + "started_at INTEGER NOT NULL,"
            + "ended_at INTEGER NOT NULL,"
            + "audio_offset_ms INTEGER,"
            + "text TEXT NOT NULL,"
            + "lang TEXT,"
            + "translation TEXT,"
            + "translation_lang TEXT,"
            + "sentiment REAL,"
            + "emotion TEXT,"
            + "search_meta TEXT,"
            + "angle INTEGER,"
            + "embedding BLOB)")
        db.execSQL("CREATE INDEX idx_segments_session ON segments(session_id)")
        db.execSQL("CREATE INDEX idx_segments_speaker ON segments(speaker_id)")
        db.execSQL("CREATE INDEX idx_segments_time ON segments(started_at)")
        db.execSQL("CREATE INDEX idx_sessions_time ON sessions(started_at)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) {
            // v2: per-speaker conversation insights (recap of the most recent
            // conversation, its action items, and accumulated inferred facts).
            db.execSQL("ALTER TABLE speakers ADD COLUMN last_recap TEXT")
            db.execSQL("ALTER TABLE speakers ADD COLUMN action_items TEXT")
            db.execSQL("ALTER TABLE speakers ADD COLUMN facts TEXT")
            db.execSQL("ALTER TABLE speakers ADD COLUMN insights_updated_at INTEGER")
            db.execSQL("ALTER TABLE speakers ADD COLUMN insights_session_id INTEGER")
        }
    }

    // ---- sessions ----

    fun startSession(startedAtMs: Long, title: String?): Long {
        val values = ContentValues()
        values.put("started_at", startedAtMs)
        values.put("title", if (title == null || title.isEmpty()) null else title)
        return writableDatabase.insert("sessions", null, values)
    }

    fun endSession(sessionId: Long, endedAtMs: Long, audioPath: String?, audioCodec: String?, avgSentiment: Double) {
        val values = ContentValues()
        values.put("ended_at", endedAtMs)
        if (audioPath != null && !audioPath.isEmpty()) {
            values.put("audio_path", audioPath)
            values.put("audio_codec", audioCodec)
        }
        values.put("avg_sentiment", avgSentiment)
        writableDatabase.update("sessions", values, "id=?", arrayOf(sessionId.toString()))
    }

    fun setSessionAudio(sessionId: Long, audioPath: String?, audioCodec: String?) {
        val values = ContentValues()
        values.put("audio_path", audioPath)
        values.put("audio_codec", audioCodec)
        writableDatabase.update("sessions", values, "id=?", arrayOf(sessionId.toString()))
    }

    fun getSessionAudioPath(sessionId: Long): String {
        readableDatabase.rawQuery(
            "SELECT audio_path FROM sessions WHERE id=?", arrayOf(sessionId.toString())).use { c ->
            if (c.moveToFirst()) {
                return if (c.isNull(0)) "" else c.getString(0)
            }
        }
        return ""
    }

    /**
     * Sessions, newest first, as JSON. filterJson supports: sinceMs, untilMs,
     * speakerId, emotion (matches any segment emotion in the session), query
     * (LIKE over title and segment text/search metadata), limit.
     */
    fun querySessions(filterJson: String?): String {
        try {
            val filter = if (filterJson == null || filterJson.isEmpty())
                JSONObject() else JSONObject(filterJson)
            val sql = StringBuilder(
                "SELECT DISTINCT s.id, s.started_at, s.ended_at, s.title, s.audio_path, s.audio_codec,"
                    + " s.avg_sentiment, s.segment_count FROM sessions s")
            val args: MutableList<String> = ArrayList()
            val where: MutableList<String> = ArrayList()
            val joinSegments = filter.has("speakerId") || filter.has("emotion") || filter.has("query")
            if (joinSegments) {
                sql.append(" LEFT JOIN segments g ON g.session_id = s.id")
            }
            if (filter.has("sinceMs")) {
                where.add("s.started_at >= ?")
                args.add(filter.getLong("sinceMs").toString())
            }
            if (filter.has("untilMs")) {
                where.add("s.started_at <= ?")
                args.add(filter.getLong("untilMs").toString())
            }
            if (filter.has("speakerId")) {
                where.add("g.speaker_id = ?")
                args.add(filter.getLong("speakerId").toString())
            }
            if (filter.has("emotion")) {
                where.add("g.emotion = ?")
                args.add(filter.getString("emotion"))
            }
            if (filter.has("query")) {
                val like = "%" + filter.getString("query") + "%"
                where.add("(s.title LIKE ? OR g.text LIKE ? OR g.search_meta LIKE ?)")
                args.add(like)
                args.add(like)
                args.add(like)
            }
            if (!where.isEmpty()) {
                sql.append(" WHERE ").append(where.joinToString(" AND "))
            }
            sql.append(" ORDER BY s.started_at DESC")
            val limit = filter.optInt("limit", 200)
            sql.append(" LIMIT ").append(Math.max(1, Math.min(limit, 1000)))

            val out = JSONArray()
            readableDatabase.rawQuery(sql.toString(), args.toTypedArray()).use { c ->
                while (c.moveToNext()) {
                    val row = JSONObject()
                    val id = c.getLong(0)
                    row.put("id", id)
                    row.put("startedAt", c.getLong(1))
                    row.put("endedAt", if (c.isNull(2)) JSONObject.NULL else c.getLong(2))
                    row.put("title", if (c.isNull(3)) "" else c.getString(3))
                    row.put("audioPath", if (c.isNull(4)) "" else c.getString(4))
                    row.put("audioCodec", if (c.isNull(5)) "" else c.getString(5))
                    row.put("avgSentiment", if (c.isNull(6)) 0.0 else c.getDouble(6))
                    row.put("segmentCount", c.getLong(7))
                    row.put("speakers", sessionSpeakersJson(id))
                    out.put(row)
                }
            }
            return out.toString()
        } catch (e: JSONException) {
            Log.w(TAG, "querySessions failed", e)
            return "[]"
        }
    }

    @Throws(JSONException::class)
    private fun sessionSpeakersJson(sessionId: Long): JSONArray {
        val out = JSONArray()
        readableDatabase.rawQuery(
            "SELECT DISTINCT p.id, p.name, p.color FROM segments g"
                + " JOIN speakers p ON p.id = g.speaker_id WHERE g.session_id=?",
            arrayOf(sessionId.toString())).use { c ->
            while (c.moveToNext()) {
                val row = JSONObject()
                row.put("id", c.getLong(0))
                row.put("name", c.getString(1))
                row.put("color", c.getString(2))
                out.put(row)
            }
        }
        return out
    }

    // ---- segments ----

    /**
     * Insert one transcript segment. json fields: sessionId, speakerId?,
     * startedAt, endedAt, audioOffsetMs?, text, lang?, translation?,
     * translationLang?, sentiment?, emotion?, searchMeta?, angle?,
     * embeddingBase64?. Returns the new row id, or -1.
     */
    fun insertSegment(json: String?): Long {
        try {
            val s = JSONObject(json)
            val values = ContentValues()
            val sessionId = s.getLong("sessionId")
            values.put("session_id", sessionId)
            if (s.has("speakerId")) {
                values.put("speaker_id", s.getLong("speakerId"))
            }
            values.put("started_at", s.getLong("startedAt"))
            values.put("ended_at", s.getLong("endedAt"))
            if (s.has("audioOffsetMs")) {
                values.put("audio_offset_ms", s.getLong("audioOffsetMs"))
            }
            values.put("text", s.getString("text"))
            putOptString(values, s, "lang", "lang")
            putOptString(values, s, "translation", "translation")
            putOptString(values, s, "translationLang", "translation_lang")
            if (s.has("sentiment")) {
                values.put("sentiment", s.getDouble("sentiment"))
            }
            putOptString(values, s, "emotion", "emotion")
            putOptString(values, s, "searchMeta", "search_meta")
            if (s.has("angle")) {
                values.put("angle", s.getInt("angle"))
            }
            if (s.has("embeddingBase64")) {
                values.put("embedding", Base64.decode(s.getString("embeddingBase64"), Base64.NO_WRAP))
            }
            val db = writableDatabase
            val id = db.insert("segments", null, values)
            db.execSQL("UPDATE sessions SET segment_count = segment_count + 1 WHERE id=?",
                arrayOf<Any?>(sessionId))
            return id
        } catch (t: Throwable) {
            Log.w(TAG, "insertSegment failed", t)
            return -1
        }
    }

    /** Update mutable fields of a segment (same keys as insertSegment). */
    fun updateSegment(segmentId: Long, json: String?) {
        try {
            val s = JSONObject(json)
            val values = ContentValues()
            if (s.has("speakerId")) {
                if (s.isNull("speakerId")) {
                    values.putNull("speaker_id")
                } else {
                    values.put("speaker_id", s.getLong("speakerId"))
                }
            }
            if (s.has("text")) {
                values.put("text", s.getString("text"))
            }
            putOptString(values, s, "lang", "lang")
            putOptString(values, s, "translation", "translation")
            putOptString(values, s, "translationLang", "translation_lang")
            if (s.has("sentiment")) {
                values.put("sentiment", s.getDouble("sentiment"))
            }
            putOptString(values, s, "emotion", "emotion")
            putOptString(values, s, "searchMeta", "search_meta")
            if (values.size() > 0) {
                writableDatabase.update("segments", values, "id=?",
                    arrayOf(segmentId.toString()))
            }
        } catch (t: Throwable) {
            Log.w(TAG, "updateSegment failed", t)
        }
    }

    fun querySegments(sessionId: Long): String {
        val out = JSONArray()
        try {
            readableDatabase.rawQuery(
                "SELECT id, speaker_id, started_at, ended_at, audio_offset_ms, text, lang,"
                    + " translation, translation_lang, sentiment, emotion, angle"
                    + " FROM segments WHERE session_id=? ORDER BY started_at ASC",
                arrayOf(sessionId.toString())).use { c ->
                while (c.moveToNext()) {
                    out.put(segmentRowJson(c))
                }
            }
        } catch (e: JSONException) {
            Log.w(TAG, "querySegments failed", e)
        }
        return out.toString()
    }

    @Throws(JSONException::class)
    private fun segmentRowJson(c: Cursor): JSONObject {
        val row = JSONObject()
        row.put("id", c.getLong(0))
        row.put("speakerId", if (c.isNull(1)) JSONObject.NULL else c.getLong(1))
        row.put("startedAt", c.getLong(2))
        row.put("endedAt", c.getLong(3))
        row.put("audioOffsetMs", if (c.isNull(4)) JSONObject.NULL else c.getLong(4))
        row.put("text", c.getString(5))
        row.put("lang", if (c.isNull(6)) "" else c.getString(6))
        row.put("translation", if (c.isNull(7)) "" else c.getString(7))
        row.put("translationLang", if (c.isNull(8)) "" else c.getString(8))
        row.put("sentiment", if (c.isNull(9)) 0.0 else c.getDouble(9))
        row.put("emotion", if (c.isNull(10)) "" else c.getString(10))
        row.put("angle", if (c.isNull(11)) JSONObject.NULL else c.getInt(11))
        return row
    }

    /**
     * Search segments across sessions. filterJson: query?, emotion?,
     * speakerId?, sinceMs?, untilMs?, limit?. Matches text, translation, and
     * the sentiment search metadata.
     */
    fun searchSegments(filterJson: String?): String {
        try {
            val filter = if (filterJson == null || filterJson.isEmpty())
                JSONObject() else JSONObject(filterJson)
            val sql = StringBuilder(
                "SELECT id, speaker_id, started_at, ended_at, audio_offset_ms, text, lang,"
                    + " translation, translation_lang, sentiment, emotion, angle, session_id"
                    + " FROM segments")
            val args: MutableList<String> = ArrayList()
            val where: MutableList<String> = ArrayList()
            if (filter.has("query") && !filter.getString("query").isEmpty()) {
                val like = "%" + filter.getString("query") + "%"
                where.add("(text LIKE ? OR translation LIKE ? OR search_meta LIKE ?)")
                args.add(like)
                args.add(like)
                args.add(like)
            }
            if (filter.has("emotion")) {
                where.add("emotion = ?")
                args.add(filter.getString("emotion"))
            }
            if (filter.has("speakerId")) {
                where.add("speaker_id = ?")
                args.add(filter.getLong("speakerId").toString())
            }
            if (filter.has("sinceMs")) {
                where.add("started_at >= ?")
                args.add(filter.getLong("sinceMs").toString())
            }
            if (filter.has("untilMs")) {
                where.add("started_at <= ?")
                args.add(filter.getLong("untilMs").toString())
            }
            if (!where.isEmpty()) {
                sql.append(" WHERE ").append(where.joinToString(" AND "))
            }
            sql.append(" ORDER BY started_at DESC LIMIT ")
                .append(Math.max(1, Math.min(filter.optInt("limit", 300), 1000)))
            val out = JSONArray()
            readableDatabase.rawQuery(sql.toString(), args.toTypedArray()).use { c ->
                while (c.moveToNext()) {
                    val row = segmentRowJson(c)
                    row.put("sessionId", c.getLong(12))
                    out.put(row)
                }
            }
            return out.toString()
        } catch (e: JSONException) {
            Log.w(TAG, "searchSegments failed", e)
            return "[]"
        }
    }

    /** Per-segment voice-print embeddings of a session (for re-diarization). */
    fun querySegmentEmbeddings(sessionId: Long): String {
        val out = JSONArray()
        try {
            readableDatabase.rawQuery(
                "SELECT id, embedding FROM segments WHERE session_id=? AND embedding IS NOT NULL",
                arrayOf(sessionId.toString())).use { c ->
                while (c.moveToNext()) {
                    val row = JSONObject()
                    row.put("id", c.getLong(0))
                    row.put("embeddingBase64", Base64.encodeToString(c.getBlob(1), Base64.NO_WRAP))
                    out.put(row)
                }
            }
        } catch (e: JSONException) {
            Log.w(TAG, "querySegmentEmbeddings failed", e)
        }
        return out.toString()
    }

    // ---- speakers ----

    fun createSpeaker(name: String?, color: String?, isWearer: Boolean, embeddingBase64: String?): Long {
        val values = ContentValues()
        values.put("name", name)
        values.put("color", if (color == null || color.isEmpty()) "#4FC3F7" else color)
        values.put("is_wearer", if (isWearer) 1 else 0)
        values.put("created_at", System.currentTimeMillis())
        values.put("last_heard_at", System.currentTimeMillis())
        if (embeddingBase64 != null && !embeddingBase64.isEmpty()) {
            values.put("embedding", Base64.decode(embeddingBase64, Base64.NO_WRAP))
            values.put("embedding_count", 1)
        }
        return writableDatabase.insert("speakers", null, values)
    }

    fun querySpeakers(): String {
        val out = JSONArray()
        try {
            readableDatabase.rawQuery(
                "SELECT p.id, p.name, p.color, p.is_wearer, p.embedding, p.embedding_count,"
                    + " p.last_heard_at, p.tag,"
                    + " p.last_recap, p.action_items, p.facts, p.insights_updated_at, p.insights_session_id,"
                    + " (SELECT COUNT(*) FROM segments g WHERE g.speaker_id = p.id) AS segments"
                    + " FROM speakers p ORDER BY p.last_heard_at DESC", null).use { c ->
                while (c.moveToNext()) {
                    val row = JSONObject()
                    row.put("id", c.getLong(0))
                    row.put("name", c.getString(1))
                    row.put("color", c.getString(2))
                    row.put("isWearer", c.getInt(3) != 0)
                    val blob = if (c.isNull(4)) null else c.getBlob(4)
                    row.put("embeddingBase64", if (blob == null) "" else Base64.encodeToString(blob, Base64.NO_WRAP))
                    row.put("embeddingCount", c.getInt(5))
                    row.put("lastHeardAt", if (c.isNull(6)) 0L else c.getLong(6))
                    row.put("tag", if (c.isNull(7)) "" else c.getString(7))
                    row.put("lastRecap", if (c.isNull(8)) "" else c.getString(8))
                    row.put("actionItemsJson", if (c.isNull(9)) "" else c.getString(9))
                    row.put("factsJson", if (c.isNull(10)) "" else c.getString(10))
                    row.put("insightsUpdatedAt", if (c.isNull(11)) 0L else c.getLong(11))
                    row.put("insightsSessionId", if (c.isNull(12)) 0L else c.getLong(12))
                    row.put("segmentCount", c.getLong(13))
                    out.put(row)
                }
            }
        } catch (e: JSONException) {
            Log.w(TAG, "querySpeakers failed", e)
        }
        return out.toString()
    }

    fun renameSpeaker(speakerId: Long, name: String?) {
        val values = ContentValues()
        values.put("name", name)
        writableDatabase.update("speakers", values, "id=?", arrayOf(speakerId.toString()))
    }

    fun setSpeakerColor(speakerId: Long, color: String?) {
        val values = ContentValues()
        values.put("color", color)
        writableDatabase.update("speakers", values, "id=?", arrayOf(speakerId.toString()))
    }

    fun setSpeakerTag(speakerId: Long, tag: String?) {
        val values = ContentValues()
        values.put("tag", tag)
        writableDatabase.update("speakers", values, "id=?", arrayOf(speakerId.toString()))
    }

    /**
     * Store LLM-derived conversation insights for a speaker: a recap of their
     * most recent conversation, its open action items (JSON string array), and
     * the accumulated inferred facts about them (JSON string array).
     */
    fun setSpeakerInsights(speakerId: Long, recap: String?, actionItemsJson: String?,
                           factsJson: String?, sessionId: Long) {
        val values = ContentValues()
        values.put("last_recap", recap ?: "")
        values.put("action_items", actionItemsJson ?: "")
        values.put("facts", factsJson ?: "")
        values.put("insights_updated_at", System.currentTimeMillis())
        values.put("insights_session_id", sessionId)
        writableDatabase.update("speakers", values, "id=?", arrayOf(speakerId.toString()))
    }

    fun setSpeakerWearer(speakerId: Long, isWearer: Boolean) {
        val db = writableDatabase
        if (isWearer) {
            // Exactly one wearer profile at a time.
            db.execSQL("UPDATE speakers SET is_wearer = 0")
        }
        val values = ContentValues()
        values.put("is_wearer", if (isWearer) 1 else 0)
        db.update("speakers", values, "id=?", arrayOf(speakerId.toString()))
    }

    /**
     * Running-mean centroid update for a speaker's voice-print, capped so a
     * long session cannot drown the enrolled voice.
     */
    fun updateSpeakerEmbedding(speakerId: Long, embeddingBase64: String?, maxCount: Int) {
        try {
            val incoming = Base64.decode(embeddingBase64, Base64.NO_WRAP)
            val update = blobToFloats(incoming)
            if (update == null) {
                return
            }
            var current: FloatArray? = null
            var count = 0
            val c = readableDatabase.rawQuery(
                "SELECT embedding, embedding_count FROM speakers WHERE id=?",
                arrayOf(speakerId.toString()))
            try {
                if (c.moveToFirst()) {
                    current = if (c.isNull(0)) null else blobToFloats(c.getBlob(0))
                    count = c.getInt(1)
                }
            } finally {
                c.close()
            }
            val merged: FloatArray
            if (current == null || current.size != update.size) {
                merged = update
                count = 1
            } else {
                val effective = Math.min(count, Math.max(1, maxCount))
                merged = FloatArray(current.size)
                for (i in merged.indices) {
                    merged[i] = (current[i] * effective + update[i]) / (effective + 1)
                }
                l2NormalizeInPlace(merged)
                count = count + 1
            }
            val values = ContentValues()
            values.put("embedding", floatsToBlob(merged))
            values.put("embedding_count", count)
            values.put("last_heard_at", System.currentTimeMillis())
            writableDatabase.update("speakers", values, "id=?",
                arrayOf(speakerId.toString()))
        } catch (t: Throwable) {
            Log.w(TAG, "updateSpeakerEmbedding failed", t)
        }
    }

    /** Move every segment from one speaker onto another and drop the source. */
    fun mergeSpeakers(fromId: Long, intoId: Long) {
        if (fromId == intoId) {
            return
        }
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.execSQL("UPDATE segments SET speaker_id=? WHERE speaker_id=?",
                arrayOf<Any?>(intoId, fromId))
            // Blend the two centroids weighted by their sample counts.
            var from: FloatArray? = null
            var into: FloatArray? = null
            var fromCount = 0
            var intoCount = 0
            var fromWearer = false
            val c = db.rawQuery(
                "SELECT id, embedding, embedding_count, is_wearer FROM speakers WHERE id IN (?,?)",
                arrayOf(fromId.toString(), intoId.toString()))
            try {
                while (c.moveToNext()) {
                    val id = c.getLong(0)
                    val embedding = if (c.isNull(1)) null else blobToFloats(c.getBlob(1))
                    val count = c.getInt(2)
                    if (id == fromId) {
                        from = embedding
                        fromCount = count
                        fromWearer = c.getInt(3) != 0
                    } else {
                        into = embedding
                        intoCount = count
                    }
                }
            } finally {
                c.close()
            }
            var merged: FloatArray? = into
            if (from != null && into != null && from.size == into.size) {
                val blended = FloatArray(into.size)
                val total = Math.max(1, fromCount + intoCount)
                for (i in blended.indices) {
                    blended[i] = (into[i] * intoCount + from[i] * fromCount) / total
                }
                l2NormalizeInPlace(blended)
                merged = blended
            } else if (into == null) {
                merged = from
            }
            val values = ContentValues()
            if (merged != null) {
                values.put("embedding", floatsToBlob(merged))
                values.put("embedding_count", fromCount + intoCount)
            }
            if (fromWearer) {
                values.put("is_wearer", 1)
            }
            values.put("last_heard_at", System.currentTimeMillis())
            // Keep the target's conversation insights; adopt the source's only
            // where the target has none (e.g. merging a rich profile into a
            // freshly auto-created one).
            db.rawQuery(
                "SELECT last_recap, action_items, facts, insights_updated_at, insights_session_id"
                    + " FROM speakers WHERE id IN (?,?) ORDER BY CASE id WHEN ? THEN 0 ELSE 1 END",
                arrayOf(fromId.toString(), intoId.toString(), intoId.toString())).use { c2 ->
                var targetHasInsights = false
                while (c2.moveToNext()) {
                    val hasInsights = !c2.isNull(0) && !c2.getString(0).isEmpty()
                    if (c2.position == 0) {
                        targetHasInsights = hasInsights
                    } else if (!targetHasInsights && hasInsights) {
                        values.put("last_recap", c2.getString(0))
                        values.put("action_items", if (c2.isNull(1)) "" else c2.getString(1))
                        values.put("facts", if (c2.isNull(2)) "" else c2.getString(2))
                        values.put("insights_updated_at", if (c2.isNull(3)) 0L else c2.getLong(3))
                        values.put("insights_session_id", if (c2.isNull(4)) 0L else c2.getLong(4))
                    }
                }
            }
            db.update("speakers", values, "id=?", arrayOf(intoId.toString()))
            db.delete("speakers", "id=?", arrayOf(fromId.toString()))
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun reassignSegmentSpeaker(segmentId: Long, speakerId: Long) {
        val values = ContentValues()
        values.put("speaker_id", speakerId)
        writableDatabase.update("segments", values, "id=?", arrayOf(segmentId.toString()))
    }

    /** Reassign every segment of a speaker within one session (split support). */
    fun reassignSessionSpeaker(sessionId: Long, fromSpeakerId: Long, toSpeakerId: Long) {
        writableDatabase.execSQL(
            "UPDATE segments SET speaker_id=? WHERE session_id=? AND speaker_id=?",
            arrayOf<Any?>(toSpeakerId, sessionId, fromSpeakerId))
    }

    fun deleteSpeaker(speakerId: Long) {
        val db = writableDatabase
        db.execSQL("UPDATE segments SET speaker_id=NULL WHERE speaker_id=?", arrayOf<Any?>(speakerId))
        db.delete("speakers", "id=?", arrayOf(speakerId.toString()))
    }

    // ---- retention ----

    /**
     * Delete caption sessions older than the cutoff (0 disables), and strip
     * recordings older than their own cutoff while keeping the transcript.
     * Returns a JSON summary of what was removed.
     */
    fun applyRetention(captionCutoffMs: Long, recordingCutoffMs: Long): String {
        val db = writableDatabase
        var sessionsDeleted = 0
        var recordingsDeleted = 0
        if (recordingCutoffMs > 0) {
            val paths: MutableList<String> = ArrayList()
            db.rawQuery(
                "SELECT id, audio_path FROM sessions WHERE audio_path IS NOT NULL AND started_at < ?",
                arrayOf(recordingCutoffMs.toString())).use { c ->
                while (c.moveToNext()) {
                    if (!c.isNull(1)) {
                        paths.add(c.getString(1))
                    }
                }
            }
            for (path in paths) {
                if (File(path).delete()) {
                    recordingsDeleted++
                }
            }
            db.execSQL("UPDATE sessions SET audio_path=NULL, audio_codec=NULL WHERE started_at < ?",
                arrayOf<Any?>(recordingCutoffMs))
        }
        if (captionCutoffMs > 0) {
            val paths: MutableList<String?> = ArrayList()
            db.rawQuery(
                "SELECT audio_path FROM sessions WHERE audio_path IS NOT NULL AND started_at < ?",
                arrayOf(captionCutoffMs.toString())).use { c ->
                while (c.moveToNext()) {
                    paths.add(c.getString(0))
                }
            }
            for (path in paths) {
                if (path != null && File(path).delete()) {
                    recordingsDeleted++
                }
            }
            db.execSQL("DELETE FROM segments WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)",
                arrayOf<Any?>(captionCutoffMs))
            val count = db.rawQuery("SELECT changes()", null)
            count.close()
            db.execSQL("DELETE FROM sessions WHERE started_at < ?", arrayOf<Any?>(captionCutoffMs))
            db.rawQuery("SELECT changes()", null).use { c ->
                if (c.moveToFirst()) {
                    sessionsDeleted = c.getInt(0)
                }
            }
        }
        try {
            val summary = JSONObject()
            summary.put("sessionsDeleted", sessionsDeleted)
            summary.put("recordingsDeleted", recordingsDeleted)
            return summary.toString()
        } catch (e: JSONException) {
            return "{}"
        }
    }

    fun deleteSession(sessionId: Long) {
        val db = writableDatabase
        val path = getSessionAudioPath(sessionId)
        if (!path.isEmpty()) {
            File(path).delete()
        }
        db.delete("segments", "session_id=?", arrayOf(sessionId.toString()))
        db.delete("sessions", "id=?", arrayOf(sessionId.toString()))
    }
}
