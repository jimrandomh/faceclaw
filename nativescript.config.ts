import { NativeScriptConfig } from '@nativescript/core';

export default {
  id: 'com.faceclaw.app',
  appPath: 'app',
  appResourcesPath: 'App_Resources',
  ios: {
    // Sideloading under another signing team needs a bundle ID that team owns.
    id: process.env.IOS_BUNDLE_ID || 'com.faceclaw.app',
  },
  android: {
    v8Flags: '--expose_gc',
    markingMode: 'none'
  }
} as NativeScriptConfig;