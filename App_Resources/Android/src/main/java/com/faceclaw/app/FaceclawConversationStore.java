package com.faceclaw.app;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;

/**
 * Persistent store for caption sessions, transcript segments, and speaker
 * voice profiles, backing the Microphones app and its phone-side review UI.
 * All complex values cross the JS bridge as JSON strings; voice-print
 * embeddings are float32 LE blobs, exposed as base64.
 */
public class FaceclawConversationStore extends SQLiteOpenHelper {
    private static final String TAG = "FaceclawConvStore";
    private static final String DB_NAME = "faceclaw-conversations.db";
    private static final int DB_VERSION = 2;

    private static FaceclawConversationStore instance;

    public static synchronized FaceclawConversationStore getInstance(Context context) {
        if (instance == null) {
            instance = new FaceclawConversationStore(context.getApplicationContext());
        }
        return instance;
    }

    private FaceclawConversationStore(Context context) {
        super(context, DB_NAME, null, DB_VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
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
                + "insights_session_id INTEGER)");
        db.execSQL("CREATE TABLE sessions ("
                + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                + "started_at INTEGER NOT NULL,"
                + "ended_at INTEGER,"
                + "title TEXT,"
                + "audio_path TEXT,"
                + "audio_codec TEXT,"
                + "avg_sentiment REAL,"
                + "segment_count INTEGER NOT NULL DEFAULT 0)");
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
                + "embedding BLOB)");
        db.execSQL("CREATE INDEX idx_segments_session ON segments(session_id)");
        db.execSQL("CREATE INDEX idx_segments_speaker ON segments(speaker_id)");
        db.execSQL("CREATE INDEX idx_segments_time ON segments(started_at)");
        db.execSQL("CREATE INDEX idx_sessions_time ON sessions(started_at)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion < 2) {
            // v2: per-speaker conversation insights (recap of the most recent
            // conversation, its action items, and accumulated inferred facts).
            db.execSQL("ALTER TABLE speakers ADD COLUMN last_recap TEXT");
            db.execSQL("ALTER TABLE speakers ADD COLUMN action_items TEXT");
            db.execSQL("ALTER TABLE speakers ADD COLUMN facts TEXT");
            db.execSQL("ALTER TABLE speakers ADD COLUMN insights_updated_at INTEGER");
            db.execSQL("ALTER TABLE speakers ADD COLUMN insights_session_id INTEGER");
        }
    }

    // ---- sessions ----

    public long startSession(long startedAtMs, String title) {
        ContentValues values = new ContentValues();
        values.put("started_at", startedAtMs);
        values.put("title", title == null || title.isEmpty() ? null : title);
        return getWritableDatabase().insert("sessions", null, values);
    }

    public void endSession(long sessionId, long endedAtMs, String audioPath, String audioCodec, double avgSentiment) {
        ContentValues values = new ContentValues();
        values.put("ended_at", endedAtMs);
        if (audioPath != null && !audioPath.isEmpty()) {
            values.put("audio_path", audioPath);
            values.put("audio_codec", audioCodec);
        }
        values.put("avg_sentiment", avgSentiment);
        getWritableDatabase().update("sessions", values, "id=?", new String[]{String.valueOf(sessionId)});
    }

    public void setSessionAudio(long sessionId, String audioPath, String audioCodec) {
        ContentValues values = new ContentValues();
        values.put("audio_path", audioPath);
        values.put("audio_codec", audioCodec);
        getWritableDatabase().update("sessions", values, "id=?", new String[]{String.valueOf(sessionId)});
    }

    public String getSessionAudioPath(long sessionId) {
        try (Cursor c = getReadableDatabase().rawQuery(
                "SELECT audio_path FROM sessions WHERE id=?", new String[]{String.valueOf(sessionId)})) {
            if (c.moveToFirst()) {
                return c.isNull(0) ? "" : c.getString(0);
            }
        }
        return "";
    }

    /**
     * Sessions, newest first, as JSON. filterJson supports: sinceMs, untilMs,
     * speakerId, emotion (matches any segment emotion in the session), query
     * (LIKE over title and segment text/search metadata), limit.
     */
    public String querySessions(String filterJson) {
        try {
            JSONObject filter = filterJson == null || filterJson.isEmpty()
                    ? new JSONObject() : new JSONObject(filterJson);
            StringBuilder sql = new StringBuilder(
                    "SELECT DISTINCT s.id, s.started_at, s.ended_at, s.title, s.audio_path, s.audio_codec,"
                            + " s.avg_sentiment, s.segment_count FROM sessions s");
            List<String> args = new ArrayList<>();
            List<String> where = new ArrayList<>();
            boolean joinSegments = filter.has("speakerId") || filter.has("emotion") || filter.has("query");
            if (joinSegments) {
                sql.append(" LEFT JOIN segments g ON g.session_id = s.id");
            }
            if (filter.has("sinceMs")) {
                where.add("s.started_at >= ?");
                args.add(String.valueOf(filter.getLong("sinceMs")));
            }
            if (filter.has("untilMs")) {
                where.add("s.started_at <= ?");
                args.add(String.valueOf(filter.getLong("untilMs")));
            }
            if (filter.has("speakerId")) {
                where.add("g.speaker_id = ?");
                args.add(String.valueOf(filter.getLong("speakerId")));
            }
            if (filter.has("emotion")) {
                where.add("g.emotion = ?");
                args.add(filter.getString("emotion"));
            }
            if (filter.has("query")) {
                String like = "%" + filter.getString("query") + "%";
                where.add("(s.title LIKE ? OR g.text LIKE ? OR g.search_meta LIKE ?)");
                args.add(like);
                args.add(like);
                args.add(like);
            }
            if (!where.isEmpty()) {
                sql.append(" WHERE ").append(String.join(" AND ", where));
            }
            sql.append(" ORDER BY s.started_at DESC");
            int limit = filter.optInt("limit", 200);
            sql.append(" LIMIT ").append(Math.max(1, Math.min(limit, 1000)));

            JSONArray out = new JSONArray();
            try (Cursor c = getReadableDatabase().rawQuery(sql.toString(), args.toArray(new String[0]))) {
                while (c.moveToNext()) {
                    JSONObject row = new JSONObject();
                    long id = c.getLong(0);
                    row.put("id", id);
                    row.put("startedAt", c.getLong(1));
                    row.put("endedAt", c.isNull(2) ? JSONObject.NULL : c.getLong(2));
                    row.put("title", c.isNull(3) ? "" : c.getString(3));
                    row.put("audioPath", c.isNull(4) ? "" : c.getString(4));
                    row.put("audioCodec", c.isNull(5) ? "" : c.getString(5));
                    row.put("avgSentiment", c.isNull(6) ? 0 : c.getDouble(6));
                    row.put("segmentCount", c.getLong(7));
                    row.put("speakers", sessionSpeakersJson(id));
                    out.put(row);
                }
            }
            return out.toString();
        } catch (JSONException e) {
            Log.w(TAG, "querySessions failed", e);
            return "[]";
        }
    }

    private JSONArray sessionSpeakersJson(long sessionId) throws JSONException {
        JSONArray out = new JSONArray();
        try (Cursor c = getReadableDatabase().rawQuery(
                "SELECT DISTINCT p.id, p.name, p.color FROM segments g"
                        + " JOIN speakers p ON p.id = g.speaker_id WHERE g.session_id=?",
                new String[]{String.valueOf(sessionId)})) {
            while (c.moveToNext()) {
                JSONObject row = new JSONObject();
                row.put("id", c.getLong(0));
                row.put("name", c.getString(1));
                row.put("color", c.getString(2));
                out.put(row);
            }
        }
        return out;
    }

    // ---- segments ----

    /**
     * Insert one transcript segment. json fields: sessionId, speakerId?,
     * startedAt, endedAt, audioOffsetMs?, text, lang?, translation?,
     * translationLang?, sentiment?, emotion?, searchMeta?, angle?,
     * embeddingBase64?. Returns the new row id, or -1.
     */
    public long insertSegment(String json) {
        try {
            JSONObject s = new JSONObject(json);
            ContentValues values = new ContentValues();
            long sessionId = s.getLong("sessionId");
            values.put("session_id", sessionId);
            if (s.has("speakerId")) {
                values.put("speaker_id", s.getLong("speakerId"));
            }
            values.put("started_at", s.getLong("startedAt"));
            values.put("ended_at", s.getLong("endedAt"));
            if (s.has("audioOffsetMs")) {
                values.put("audio_offset_ms", s.getLong("audioOffsetMs"));
            }
            values.put("text", s.getString("text"));
            putOptString(values, s, "lang", "lang");
            putOptString(values, s, "translation", "translation");
            putOptString(values, s, "translationLang", "translation_lang");
            if (s.has("sentiment")) {
                values.put("sentiment", s.getDouble("sentiment"));
            }
            putOptString(values, s, "emotion", "emotion");
            putOptString(values, s, "searchMeta", "search_meta");
            if (s.has("angle")) {
                values.put("angle", s.getInt("angle"));
            }
            if (s.has("embeddingBase64")) {
                values.put("embedding", Base64.decode(s.getString("embeddingBase64"), Base64.NO_WRAP));
            }
            SQLiteDatabase db = getWritableDatabase();
            long id = db.insert("segments", null, values);
            db.execSQL("UPDATE sessions SET segment_count = segment_count + 1 WHERE id=?",
                    new Object[]{sessionId});
            return id;
        } catch (Throwable t) {
            Log.w(TAG, "insertSegment failed", t);
            return -1;
        }
    }

    private static void putOptString(ContentValues values, JSONObject s, String jsonKey, String column)
            throws JSONException {
        if (s.has(jsonKey) && !s.isNull(jsonKey)) {
            values.put(column, s.getString(jsonKey));
        }
    }

    /** Update mutable fields of a segment (same keys as insertSegment). */
    public void updateSegment(long segmentId, String json) {
        try {
            JSONObject s = new JSONObject(json);
            ContentValues values = new ContentValues();
            if (s.has("speakerId")) {
                if (s.isNull("speakerId")) {
                    values.putNull("speaker_id");
                } else {
                    values.put("speaker_id", s.getLong("speakerId"));
                }
            }
            if (s.has("text")) {
                values.put("text", s.getString("text"));
            }
            putOptString(values, s, "lang", "lang");
            putOptString(values, s, "translation", "translation");
            putOptString(values, s, "translationLang", "translation_lang");
            if (s.has("sentiment")) {
                values.put("sentiment", s.getDouble("sentiment"));
            }
            putOptString(values, s, "emotion", "emotion");
            putOptString(values, s, "searchMeta", "search_meta");
            if (values.size() > 0) {
                getWritableDatabase().update("segments", values, "id=?",
                        new String[]{String.valueOf(segmentId)});
            }
        } catch (Throwable t) {
            Log.w(TAG, "updateSegment failed", t);
        }
    }

    public String querySegments(long sessionId) {
        JSONArray out = new JSONArray();
        try (Cursor c = getReadableDatabase().rawQuery(
                "SELECT id, speaker_id, started_at, ended_at, audio_offset_ms, text, lang,"
                        + " translation, translation_lang, sentiment, emotion, angle"
                        + " FROM segments WHERE session_id=? ORDER BY started_at ASC",
                new String[]{String.valueOf(sessionId)})) {
            while (c.moveToNext()) {
                out.put(segmentRowJson(c));
            }
        } catch (JSONException e) {
            Log.w(TAG, "querySegments failed", e);
        }
        return out.toString();
    }

    private JSONObject segmentRowJson(Cursor c) throws JSONException {
        JSONObject row = new JSONObject();
        row.put("id", c.getLong(0));
        row.put("speakerId", c.isNull(1) ? JSONObject.NULL : c.getLong(1));
        row.put("startedAt", c.getLong(2));
        row.put("endedAt", c.getLong(3));
        row.put("audioOffsetMs", c.isNull(4) ? JSONObject.NULL : c.getLong(4));
        row.put("text", c.getString(5));
        row.put("lang", c.isNull(6) ? "" : c.getString(6));
        row.put("translation", c.isNull(7) ? "" : c.getString(7));
        row.put("translationLang", c.isNull(8) ? "" : c.getString(8));
        row.put("sentiment", c.isNull(9) ? 0 : c.getDouble(9));
        row.put("emotion", c.isNull(10) ? "" : c.getString(10));
        row.put("angle", c.isNull(11) ? JSONObject.NULL : c.getInt(11));
        return row;
    }

    /**
     * Search segments across sessions. filterJson: query?, emotion?,
     * speakerId?, sinceMs?, untilMs?, limit?. Matches text, translation, and
     * the sentiment search metadata.
     */
    public String searchSegments(String filterJson) {
        try {
            JSONObject filter = filterJson == null || filterJson.isEmpty()
                    ? new JSONObject() : new JSONObject(filterJson);
            StringBuilder sql = new StringBuilder(
                    "SELECT id, speaker_id, started_at, ended_at, audio_offset_ms, text, lang,"
                            + " translation, translation_lang, sentiment, emotion, angle, session_id"
                            + " FROM segments");
            List<String> args = new ArrayList<>();
            List<String> where = new ArrayList<>();
            if (filter.has("query") && !filter.getString("query").isEmpty()) {
                String like = "%" + filter.getString("query") + "%";
                where.add("(text LIKE ? OR translation LIKE ? OR search_meta LIKE ?)");
                args.add(like);
                args.add(like);
                args.add(like);
            }
            if (filter.has("emotion")) {
                where.add("emotion = ?");
                args.add(filter.getString("emotion"));
            }
            if (filter.has("speakerId")) {
                where.add("speaker_id = ?");
                args.add(String.valueOf(filter.getLong("speakerId")));
            }
            if (filter.has("sinceMs")) {
                where.add("started_at >= ?");
                args.add(String.valueOf(filter.getLong("sinceMs")));
            }
            if (filter.has("untilMs")) {
                where.add("started_at <= ?");
                args.add(String.valueOf(filter.getLong("untilMs")));
            }
            if (!where.isEmpty()) {
                sql.append(" WHERE ").append(String.join(" AND ", where));
            }
            sql.append(" ORDER BY started_at DESC LIMIT ")
                    .append(Math.max(1, Math.min(filter.optInt("limit", 300), 1000)));
            JSONArray out = new JSONArray();
            try (Cursor c = getReadableDatabase().rawQuery(sql.toString(), args.toArray(new String[0]))) {
                while (c.moveToNext()) {
                    JSONObject row = segmentRowJson(c);
                    row.put("sessionId", c.getLong(12));
                    out.put(row);
                }
            }
            return out.toString();
        } catch (JSONException e) {
            Log.w(TAG, "searchSegments failed", e);
            return "[]";
        }
    }

    /** Per-segment voice-print embeddings of a session (for re-diarization). */
    public String querySegmentEmbeddings(long sessionId) {
        JSONArray out = new JSONArray();
        try (Cursor c = getReadableDatabase().rawQuery(
                "SELECT id, embedding FROM segments WHERE session_id=? AND embedding IS NOT NULL",
                new String[]{String.valueOf(sessionId)})) {
            while (c.moveToNext()) {
                JSONObject row = new JSONObject();
                row.put("id", c.getLong(0));
                row.put("embeddingBase64", Base64.encodeToString(c.getBlob(1), Base64.NO_WRAP));
                out.put(row);
            }
        } catch (JSONException e) {
            Log.w(TAG, "querySegmentEmbeddings failed", e);
        }
        return out.toString();
    }

    // ---- speakers ----

    public long createSpeaker(String name, String color, boolean isWearer, String embeddingBase64) {
        ContentValues values = new ContentValues();
        values.put("name", name);
        values.put("color", color == null || color.isEmpty() ? "#4FC3F7" : color);
        values.put("is_wearer", isWearer ? 1 : 0);
        values.put("created_at", System.currentTimeMillis());
        values.put("last_heard_at", System.currentTimeMillis());
        if (embeddingBase64 != null && !embeddingBase64.isEmpty()) {
            values.put("embedding", Base64.decode(embeddingBase64, Base64.NO_WRAP));
            values.put("embedding_count", 1);
        }
        return getWritableDatabase().insert("speakers", null, values);
    }

    public String querySpeakers() {
        JSONArray out = new JSONArray();
        try (Cursor c = getReadableDatabase().rawQuery(
                "SELECT p.id, p.name, p.color, p.is_wearer, p.embedding, p.embedding_count,"
                        + " p.last_heard_at, p.tag,"
                        + " p.last_recap, p.action_items, p.facts, p.insights_updated_at, p.insights_session_id,"
                        + " (SELECT COUNT(*) FROM segments g WHERE g.speaker_id = p.id) AS segments"
                        + " FROM speakers p ORDER BY p.last_heard_at DESC", null)) {
            while (c.moveToNext()) {
                JSONObject row = new JSONObject();
                row.put("id", c.getLong(0));
                row.put("name", c.getString(1));
                row.put("color", c.getString(2));
                row.put("isWearer", c.getInt(3) != 0);
                byte[] blob = c.isNull(4) ? null : c.getBlob(4);
                row.put("embeddingBase64", blob == null ? "" : Base64.encodeToString(blob, Base64.NO_WRAP));
                row.put("embeddingCount", c.getInt(5));
                row.put("lastHeardAt", c.isNull(6) ? 0 : c.getLong(6));
                row.put("tag", c.isNull(7) ? "" : c.getString(7));
                row.put("lastRecap", c.isNull(8) ? "" : c.getString(8));
                row.put("actionItemsJson", c.isNull(9) ? "" : c.getString(9));
                row.put("factsJson", c.isNull(10) ? "" : c.getString(10));
                row.put("insightsUpdatedAt", c.isNull(11) ? 0 : c.getLong(11));
                row.put("insightsSessionId", c.isNull(12) ? 0 : c.getLong(12));
                row.put("segmentCount", c.getLong(13));
                out.put(row);
            }
        } catch (JSONException e) {
            Log.w(TAG, "querySpeakers failed", e);
        }
        return out.toString();
    }

    public void renameSpeaker(long speakerId, String name) {
        ContentValues values = new ContentValues();
        values.put("name", name);
        getWritableDatabase().update("speakers", values, "id=?", new String[]{String.valueOf(speakerId)});
    }

    public void setSpeakerColor(long speakerId, String color) {
        ContentValues values = new ContentValues();
        values.put("color", color);
        getWritableDatabase().update("speakers", values, "id=?", new String[]{String.valueOf(speakerId)});
    }

    public void setSpeakerTag(long speakerId, String tag) {
        ContentValues values = new ContentValues();
        values.put("tag", tag);
        getWritableDatabase().update("speakers", values, "id=?", new String[]{String.valueOf(speakerId)});
    }

    /**
     * Store LLM-derived conversation insights for a speaker: a recap of their
     * most recent conversation, its open action items (JSON string array), and
     * the accumulated inferred facts about them (JSON string array).
     */
    public void setSpeakerInsights(long speakerId, String recap, String actionItemsJson,
                                   String factsJson, long sessionId) {
        ContentValues values = new ContentValues();
        values.put("last_recap", recap == null ? "" : recap);
        values.put("action_items", actionItemsJson == null ? "" : actionItemsJson);
        values.put("facts", factsJson == null ? "" : factsJson);
        values.put("insights_updated_at", System.currentTimeMillis());
        values.put("insights_session_id", sessionId);
        getWritableDatabase().update("speakers", values, "id=?", new String[]{String.valueOf(speakerId)});
    }

    public void setSpeakerWearer(long speakerId, boolean isWearer) {
        SQLiteDatabase db = getWritableDatabase();
        if (isWearer) {
            // Exactly one wearer profile at a time.
            db.execSQL("UPDATE speakers SET is_wearer = 0");
        }
        ContentValues values = new ContentValues();
        values.put("is_wearer", isWearer ? 1 : 0);
        db.update("speakers", values, "id=?", new String[]{String.valueOf(speakerId)});
    }

    /**
     * Running-mean centroid update for a speaker's voice-print, capped so a
     * long session cannot drown the enrolled voice.
     */
    public void updateSpeakerEmbedding(long speakerId, String embeddingBase64, int maxCount) {
        try {
            byte[] incoming = Base64.decode(embeddingBase64, Base64.NO_WRAP);
            float[] update = blobToFloats(incoming);
            if (update == null) {
                return;
            }
            float[] current = null;
            int count = 0;
            try (Cursor c = getReadableDatabase().rawQuery(
                    "SELECT embedding, embedding_count FROM speakers WHERE id=?",
                    new String[]{String.valueOf(speakerId)})) {
                if (c.moveToFirst()) {
                    current = c.isNull(0) ? null : blobToFloats(c.getBlob(0));
                    count = c.getInt(1);
                }
            }
            float[] merged;
            if (current == null || current.length != update.length) {
                merged = update;
                count = 1;
            } else {
                int effective = Math.min(count, Math.max(1, maxCount));
                merged = new float[current.length];
                for (int i = 0; i < merged.length; i++) {
                    merged[i] = (current[i] * effective + update[i]) / (effective + 1);
                }
                l2NormalizeInPlace(merged);
                count = count + 1;
            }
            ContentValues values = new ContentValues();
            values.put("embedding", floatsToBlob(merged));
            values.put("embedding_count", count);
            values.put("last_heard_at", System.currentTimeMillis());
            getWritableDatabase().update("speakers", values, "id=?",
                    new String[]{String.valueOf(speakerId)});
        } catch (Throwable t) {
            Log.w(TAG, "updateSpeakerEmbedding failed", t);
        }
    }

    /** Move every segment from one speaker onto another and drop the source. */
    public void mergeSpeakers(long fromId, long intoId) {
        if (fromId == intoId) {
            return;
        }
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            db.execSQL("UPDATE segments SET speaker_id=? WHERE speaker_id=?",
                    new Object[]{intoId, fromId});
            // Blend the two centroids weighted by their sample counts.
            float[] from = null;
            float[] into = null;
            int fromCount = 0;
            int intoCount = 0;
            boolean fromWearer = false;
            try (Cursor c = db.rawQuery(
                    "SELECT id, embedding, embedding_count, is_wearer FROM speakers WHERE id IN (?,?)",
                    new String[]{String.valueOf(fromId), String.valueOf(intoId)})) {
                while (c.moveToNext()) {
                    long id = c.getLong(0);
                    float[] embedding = c.isNull(1) ? null : blobToFloats(c.getBlob(1));
                    int count = c.getInt(2);
                    if (id == fromId) {
                        from = embedding;
                        fromCount = count;
                        fromWearer = c.getInt(3) != 0;
                    } else {
                        into = embedding;
                        intoCount = count;
                    }
                }
            }
            float[] merged = into;
            if (from != null && into != null && from.length == into.length) {
                merged = new float[into.length];
                int total = Math.max(1, fromCount + intoCount);
                for (int i = 0; i < merged.length; i++) {
                    merged[i] = (into[i] * intoCount + from[i] * fromCount) / total;
                }
                l2NormalizeInPlace(merged);
            } else if (into == null) {
                merged = from;
            }
            ContentValues values = new ContentValues();
            if (merged != null) {
                values.put("embedding", floatsToBlob(merged));
                values.put("embedding_count", fromCount + intoCount);
            }
            if (fromWearer) {
                values.put("is_wearer", 1);
            }
            values.put("last_heard_at", System.currentTimeMillis());
            // Keep the target's conversation insights; adopt the source's only
            // where the target has none (e.g. merging a rich profile into a
            // freshly auto-created one).
            try (Cursor c = db.rawQuery(
                    "SELECT last_recap, action_items, facts, insights_updated_at, insights_session_id"
                            + " FROM speakers WHERE id IN (?,?) ORDER BY CASE id WHEN ? THEN 0 ELSE 1 END",
                    new String[]{String.valueOf(fromId), String.valueOf(intoId), String.valueOf(intoId)})) {
                boolean targetHasInsights = false;
                while (c.moveToNext()) {
                    boolean hasInsights = !c.isNull(0) && !c.getString(0).isEmpty();
                    if (c.getPosition() == 0) {
                        targetHasInsights = hasInsights;
                    } else if (!targetHasInsights && hasInsights) {
                        values.put("last_recap", c.getString(0));
                        values.put("action_items", c.isNull(1) ? "" : c.getString(1));
                        values.put("facts", c.isNull(2) ? "" : c.getString(2));
                        values.put("insights_updated_at", c.isNull(3) ? 0 : c.getLong(3));
                        values.put("insights_session_id", c.isNull(4) ? 0 : c.getLong(4));
                    }
                }
            }
            db.update("speakers", values, "id=?", new String[]{String.valueOf(intoId)});
            db.delete("speakers", "id=?", new String[]{String.valueOf(fromId)});
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public void reassignSegmentSpeaker(long segmentId, long speakerId) {
        ContentValues values = new ContentValues();
        values.put("speaker_id", speakerId);
        getWritableDatabase().update("segments", values, "id=?", new String[]{String.valueOf(segmentId)});
    }

    /** Reassign every segment of a speaker within one session (split support). */
    public void reassignSessionSpeaker(long sessionId, long fromSpeakerId, long toSpeakerId) {
        getWritableDatabase().execSQL(
                "UPDATE segments SET speaker_id=? WHERE session_id=? AND speaker_id=?",
                new Object[]{toSpeakerId, sessionId, fromSpeakerId});
    }

    public void deleteSpeaker(long speakerId) {
        SQLiteDatabase db = getWritableDatabase();
        db.execSQL("UPDATE segments SET speaker_id=NULL WHERE speaker_id=?", new Object[]{speakerId});
        db.delete("speakers", "id=?", new String[]{String.valueOf(speakerId)});
    }

    // ---- retention ----

    /**
     * Delete caption sessions older than the cutoff (0 disables), and strip
     * recordings older than their own cutoff while keeping the transcript.
     * Returns a JSON summary of what was removed.
     */
    public String applyRetention(long captionCutoffMs, long recordingCutoffMs) {
        SQLiteDatabase db = getWritableDatabase();
        int sessionsDeleted = 0;
        int recordingsDeleted = 0;
        if (recordingCutoffMs > 0) {
            List<String> paths = new ArrayList<>();
            try (Cursor c = db.rawQuery(
                    "SELECT id, audio_path FROM sessions WHERE audio_path IS NOT NULL AND started_at < ?",
                    new String[]{String.valueOf(recordingCutoffMs)})) {
                while (c.moveToNext()) {
                    if (!c.isNull(1)) {
                        paths.add(c.getString(1));
                    }
                }
            }
            for (String path : paths) {
                if (new File(path).delete()) {
                    recordingsDeleted++;
                }
            }
            db.execSQL("UPDATE sessions SET audio_path=NULL, audio_codec=NULL WHERE started_at < ?",
                    new Object[]{recordingCutoffMs});
        }
        if (captionCutoffMs > 0) {
            List<String> paths = new ArrayList<>();
            try (Cursor c = db.rawQuery(
                    "SELECT audio_path FROM sessions WHERE audio_path IS NOT NULL AND started_at < ?",
                    new String[]{String.valueOf(captionCutoffMs)})) {
                while (c.moveToNext()) {
                    paths.add(c.getString(0));
                }
            }
            for (String path : paths) {
                if (path != null && new File(path).delete()) {
                    recordingsDeleted++;
                }
            }
            db.execSQL("DELETE FROM segments WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)",
                    new Object[]{captionCutoffMs});
            Cursor count = db.rawQuery("SELECT changes()", null);
            count.close();
            db.execSQL("DELETE FROM sessions WHERE started_at < ?", new Object[]{captionCutoffMs});
            try (Cursor c = db.rawQuery("SELECT changes()", null)) {
                if (c.moveToFirst()) {
                    sessionsDeleted = c.getInt(0);
                }
            }
        }
        try {
            JSONObject summary = new JSONObject();
            summary.put("sessionsDeleted", sessionsDeleted);
            summary.put("recordingsDeleted", recordingsDeleted);
            return summary.toString();
        } catch (JSONException e) {
            return "{}";
        }
    }

    public void deleteSession(long sessionId) {
        SQLiteDatabase db = getWritableDatabase();
        String path = getSessionAudioPath(sessionId);
        if (!path.isEmpty()) {
            new File(path).delete();
        }
        db.delete("segments", "session_id=?", new String[]{String.valueOf(sessionId)});
        db.delete("sessions", "id=?", new String[]{String.valueOf(sessionId)});
    }

    // ---- blob helpers ----

    private static float[] blobToFloats(byte[] blob) {
        if (blob == null || blob.length < 4 || blob.length % 4 != 0) {
            return null;
        }
        ByteBuffer buffer = ByteBuffer.wrap(blob).order(ByteOrder.LITTLE_ENDIAN);
        float[] out = new float[blob.length / 4];
        for (int i = 0; i < out.length; i++) {
            out[i] = buffer.getFloat();
        }
        return out;
    }

    private static byte[] floatsToBlob(float[] values) {
        ByteBuffer buffer = ByteBuffer.allocate(values.length * 4).order(ByteOrder.LITTLE_ENDIAN);
        for (float v : values) {
            buffer.putFloat(v);
        }
        return buffer.array();
    }

    private static void l2NormalizeInPlace(float[] v) {
        double sum = 0;
        for (float x : v) {
            sum += (double) x * x;
        }
        double norm = Math.sqrt(sum);
        if (norm <= 0) {
            return;
        }
        for (int i = 0; i < v.length; i++) {
            v[i] = (float) (v[i] / norm);
        }
    }
}
