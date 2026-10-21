const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// Test and live servers may run simultaneously. Keep their compiled entrypoints
// separate: public environment values are inlined into App.tsx by Expo.
config.cacheVersion = `rocento-${process.env.EXPO_PUBLIC_DEMO ?? '0'}-${process.env.EXPO_PUBLIC_ACCEPTANCE ?? '0'}-${process.env.EXPO_PUBLIC_VISUAL_QA ?? '0'}`;
module.exports = config;
