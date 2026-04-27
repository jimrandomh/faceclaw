package com.faceclaw.app;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.KeywordSpotter;
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig;
import com.k2fsa.sherpa.onnx.KeywordSpotterResult;
import com.k2fsa.sherpa.onnx.OnlineModelConfig;
import com.k2fsa.sherpa.onnx.OnlineStream;
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Set;

public class FaceclawVoiceController {
    private static final String TAG = "FaceclawVoice";
    private static final int SAMPLE_RATE = 16000;
    private static final int FEATURE_DIM = 80;
    private static final String ASSET_ROOT = "faceclaw-voice";
    private static final String MODEL_DIR = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";
    private static final String[] MODEL_FILES = {
            "encoder-epoch-12-avg-2-chunk-16-left-64.onnx",
            "decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
            "joiner-epoch-12-avg-2-chunk-16-left-64.onnx",
            "tokens.txt",
            "screen-on-keywords.txt"
    };

    private final Context appContext;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Object lock = new Object();
    private volatile FaceclawVoiceControllerListener listener;
    private Thread workerThread;
    private volatile boolean started;
    private AudioRecord audioRecord;
    private KeywordSpotter keywordSpotter;
    private OnlineStream stream;

    public FaceclawVoiceController(Context context) {
        this.appContext = context.getApplicationContext();
    }

    public void setListener(FaceclawVoiceControllerListener listener) {
        this.listener = listener;
    }

    public void start() {
        synchronized (lock) {
            if (started) {
                emitStatus("Voice control is already listening.");
                return;
            }
            if (!hasRecordAudioPermission()) {
                emitStatus("Voice control needs microphone permission.");
                return;
            }
            if (!hasBluetoothHeadset()) {
                emitStatus("Voice control needs a paired Bluetooth headset.");
                return;
            }
            started = true;
            workerThread = new Thread(this::runLoop, "FaceclawVoiceController");
            workerThread.start();
        }
    }

    public void stop() {
        Thread threadToJoin;
        synchronized (lock) {
            if (!started) {
                return;
            }
            started = false;
            threadToJoin = workerThread;
        }
        stopAudio();
        if (threadToJoin != null) {
            threadToJoin.interrupt();
        }
    }

    public void close() {
        stop();
    }

    private void runLoop() {
        try {
            emitStatus("Voice control loading wake-word model...");
            File modelDir = installModelFiles();
            keywordSpotter = new KeywordSpotter(buildConfig(modelDir));
            stream = keywordSpotter.createStream();
            if (!startAudio()) {
                emitStatus("Voice control could not start microphone input.");
                return;
            }

            emitStatus("Voice control listening for \"screen on\".");
            processAudio();
        } catch (Throwable error) {
            Log.e(TAG, "Voice control failed", error);
            emitStatus("Voice control failed: " + error.getMessage());
        } finally {
            releaseSherpa();
            stopAudio();
            synchronized (lock) {
                started = false;
                workerThread = null;
            }
        }
    }

    private KeywordSpotterConfig buildConfig(File modelDir) {
        return KeywordSpotterConfig.builder()
                .setFeatureConfig(FeatureConfig.builder()
                        .setSampleRate(SAMPLE_RATE)
                        .setFeatureDim(FEATURE_DIM)
                        .build())
                .setOnlineModelConfig(OnlineModelConfig.builder()
                        .setTransducer(OnlineTransducerModelConfig.builder()
                                .setEncoder(new File(modelDir, "encoder-epoch-12-avg-2-chunk-16-left-64.onnx").getAbsolutePath())
                                .setDecoder(new File(modelDir, "decoder-epoch-12-avg-2-chunk-16-left-64.onnx").getAbsolutePath())
                                .setJoiner(new File(modelDir, "joiner-epoch-12-avg-2-chunk-16-left-64.onnx").getAbsolutePath())
                                .build())
                        .setTokens(new File(modelDir, "tokens.txt").getAbsolutePath())
                        .setModelType("zipformer2")
                        .setNumThreads(1)
                        .build())
                .setKeywordsFile(new File(modelDir, "screen-on-keywords.txt").getAbsolutePath())
                .setKeywordsScore(1.5f)
                .setKeywordsThreshold(0.35f)
                .build();
    }

    private File installModelFiles() throws IOException {
        File modelDir = new File(appContext.getFilesDir(), ASSET_ROOT + File.separator + MODEL_DIR);
        if (!modelDir.exists() && !modelDir.mkdirs()) {
            throw new IOException("Could not create " + modelDir.getAbsolutePath());
        }
        AssetManager assets = appContext.getAssets();
        for (String fileName : MODEL_FILES) {
            copyAssetIfNeeded(
                    assets,
                    ASSET_ROOT + "/" + MODEL_DIR + "/" + fileName,
                    new File(modelDir, fileName)
            );
        }
        return modelDir;
    }

    private void copyAssetIfNeeded(AssetManager assets, String assetPath, File destination) throws IOException {
        if (destination.exists() && destination.length() > 0) {
            return;
        }
        try (InputStream input = assets.open(assetPath);
             FileOutputStream output = new FileOutputStream(destination)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                output.write(buffer, 0, read);
            }
        }
    }

    private boolean startAudio() {
        routeToBluetoothHeadset();
        int minBufferBytes = AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
        );
        if (minBufferBytes <= 0) {
            return false;
        }
        if (!hasRecordAudioPermission()) {
            return false;
        }
        audioRecord = new AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBufferBytes * 2
        );
        if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
            audioRecord.release();
            audioRecord = null;
            return false;
        }
        audioRecord.startRecording();
        return true;
    }

    private void processAudio() {
        short[] buffer = new short[SAMPLE_RATE / 10];
        while (started && !Thread.currentThread().isInterrupted()) {
            AudioRecord currentAudio = audioRecord;
            OnlineStream currentStream = stream;
            KeywordSpotter currentSpotter = keywordSpotter;
            if (currentAudio == null || currentStream == null || currentSpotter == null) {
                return;
            }

            int count = currentAudio.read(buffer, 0, buffer.length);
            if (count <= 0) {
                continue;
            }

            float[] samples = new float[count];
            for (int i = 0; i < count; i++) {
                samples[i] = buffer[i] / 32768.0f;
            }
            currentStream.acceptWaveform(samples, SAMPLE_RATE);

            while (currentSpotter.isReady(currentStream)) {
                currentSpotter.decode(currentStream);
                KeywordSpotterResult result = currentSpotter.getResult(currentStream);
                String keyword = result == null ? "" : result.getKeyword();
                if (keyword != null && keyword.trim().length() > 0) {
                    currentSpotter.reset(currentStream);
                    emitWakeWord(keyword);
                }
            }
        }
    }

    private void stopAudio() {
        AudioRecord record = audioRecord;
        audioRecord = null;
        if (record != null) {
            try {
                record.stop();
            } catch (IllegalStateException ignored) {
            }
            record.release();
        }
        AudioManager audioManager = (AudioManager) appContext.getSystemService(Context.AUDIO_SERVICE);
        if (audioManager != null) {
            if (Build.VERSION.SDK_INT >= 31) {
                audioManager.clearCommunicationDevice();
            }
            audioManager.stopBluetoothSco();
            audioManager.setBluetoothScoOn(false);
        }
    }

    private void releaseSherpa() {
        if (stream != null) {
            stream.release();
            stream = null;
        }
        if (keywordSpotter != null) {
            keywordSpotter.release();
            keywordSpotter = null;
        }
    }

    private void routeToBluetoothHeadset() {
        AudioManager audioManager = (AudioManager) appContext.getSystemService(Context.AUDIO_SERVICE);
        if (audioManager == null) {
            return;
        }
        audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
        audioManager.startBluetoothSco();
        audioManager.setBluetoothScoOn(true);
        if (Build.VERSION.SDK_INT >= 31) {
            for (AudioDeviceInfo device : audioManager.getAvailableCommunicationDevices()) {
                if (device.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                        || device.getType() == AudioDeviceInfo.TYPE_BLE_HEADSET) {
                    audioManager.setCommunicationDevice(device);
                    return;
                }
            }
        }
    }

    private boolean hasBluetoothHeadset() {
        if (Build.VERSION.SDK_INT >= 31
                && ContextCompat.checkSelfPermission(appContext, Manifest.permission.BLUETOOTH_CONNECT)
                != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        BluetoothManager manager = (BluetoothManager) appContext.getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        if (adapter == null) {
            return false;
        }
        try {
            int state = adapter.getProfileConnectionState(BluetoothProfile.HEADSET);
            if (state == BluetoothProfile.STATE_CONNECTED || state == BluetoothProfile.STATE_CONNECTING) {
                return true;
            }
            Set<BluetoothDevice> bondedDevices = adapter.getBondedDevices();
            return bondedDevices != null && !bondedDevices.isEmpty();
        } catch (SecurityException ignored) {
            return false;
        }
    }

    private boolean hasRecordAudioPermission() {
        return ContextCompat.checkSelfPermission(appContext, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void emitStatus(String status) {
        FaceclawVoiceControllerListener currentListener = listener;
        if (currentListener == null) {
            return;
        }
        mainHandler.post(() -> currentListener.onStatus(status));
    }

    private void emitWakeWord(String keyword) {
        FaceclawVoiceControllerListener currentListener = listener;
        if (currentListener == null) {
            return;
        }
        mainHandler.post(() -> currentListener.onWakeWord(keyword));
    }
}
