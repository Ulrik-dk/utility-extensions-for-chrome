# YouTube Summary

A minimalist Chrome extension that copies the current YouTube video's transcript, with a brief-summary prompt, to your clipboard, then opens a fresh Claude or ChatGPT tab so you can paste it in.

It's very easy to get caught up in fear of missing out on useful information. Using this convenient extension to quickly get a summary of a potentially hours-long youtube video / podcast can save you a lot of time and mental energy without feeling like you are missing out.

## Install

This extension isn't published on the Chrome Web Store, so install it unpacked in developer mode:

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome (or another Chromium-based browser like Edge or Brave).
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `youtube-summary` folder from this repository.
5. The "YouTube Summary" icon will appear in your toolbar. Pin it for easy access.

## Usage

1. Open any YouTube video that has a transcript available.
2. Click the YouTube Summary icon in your toolbar.
3. Click **Open in Claude** or **Open in ChatGPT**.
4. The video's transcript, along with a "summarize the main points" prompt, is copied to your clipboard, and a new tab opens to the chosen AI chat. Paste (Ctrl/Cmd+V) into the chat to get your summary.

## How it works

YouTube's public transcript API is locked down for anti-bot reasons, so this extension instead opens the page's own "Show transcript" panel and reads the text directly out of it — the same code path YouTube's own UI relies on.

## Permissions

- `activeTab` / `scripting` — used to read the transcript panel from the current YouTube tab.
- `clipboardWrite` — used to copy the transcript and prompt to your clipboard.

No data is sent anywhere except your clipboard and the AI chat tab you choose to open.
