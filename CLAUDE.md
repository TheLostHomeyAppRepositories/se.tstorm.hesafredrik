# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Homey app called "Hesa Fredrik" that delivers Swedish VMA (Viktigt Meddelande till Allmänheten - Important Public Announcements) messages to Homey smart home devices. The app polls the Swedish Radio VMA API to detect emergency alerts and triggers notifications in the Homey ecosystem.

## Development Commands

```bash
# Install dependencies (run from se.tstorm.hesafredrik/ directory)
npm install

# Run linting
npm run lint

# Install Homey CLI globally (if not installed)
npm install -g homey

# Run the app on a local Homey device (from se.tstorm.hesafredrik/ directory)
homey app run

# Build the app for publishing
homey app build

# Validate app before publishing
homey app validate

# Publish app to Homey App Store
homey app publish
```

## Architecture & Key Components

### App Structure
The actual Homey app resides in the `se.tstorm.hesafredrik/` directory. The root directory contains repository files and MP3 audio clips for alarm sounds.

### Core Files
- **app.json**: Generated from `.homeycompose/` files - DO NOT edit directly. Contains app manifest with capabilities, flow cards, and driver definitions.
- **app.js**: Main app entry point - minimal initialization logic.
- **drivers/vma/device.js**: Core VMA device implementation that:
  - Polls SR VMA API every 29 seconds for new alerts
  - Manages incident tracking via device store
  - Handles test mode with separate test API endpoint
  - Triggers flow cards when new VMA messages arrive
- **drivers/vma/driver.js**: Handles device pairing and county/area selection
- **drivers/vma/areacodes.js**: Contains Swedish county and municipality codes for VMA regions

### API Integration
The app integrates with Sveriges Radio VMA API:
- Production: `https://vmaapi.sr.se/api/v2/alerts/{areacode}/index.json`
- Test: `https://vmaapi.sr.se/testapi/v2/alerts/{areacode}/index.json`

### Homey Compose Pattern
This app uses Homey's compose pattern - configuration is split across `.homeycompose/` files:
- Edit `.homeycompose/app.json` for app metadata
- Edit `driver.compose.json`, `driver.flow.compose.json`, `driver.settings.compose.json` for driver configuration
- Run `homey app build` to generate the final `app.json`

### Capabilities & Flow Cards
- **Capabilities**: `onoff` (enable/disable), `alarm_generic` (active alert indicator), `message` (VMA message text)
- **Flow Trigger**: `vma_trigger` - Fires when new VMA message is received, provides message text and test flag tokens

### Localization
The app supports English and Swedish localization. Translation files are in `locales/` directory.

## Testing Considerations

The app includes a test mode setting that switches to SR's test API endpoint, allowing safe testing without triggering actual emergency alerts. Enable via device settings.

## Publishing Notes

When preparing a release:
1. Update version in `.homeycompose/app.json`
2. Run `homey app build` to regenerate app.json
3. Update `.homeychangelog.json` with release notes
4. Validate with `homey app validate`
5. Publish with `homey app publish`
- Sveriges Radio's API for Important Public Announcements: https://vmaapi.sr.se/swagger/v3.0/swagger.json