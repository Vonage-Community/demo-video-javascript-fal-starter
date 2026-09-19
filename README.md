# Vonage Video API x fal starter

This application is intended to be to help developers integrate the [Vonage Video API](https://developer.vonage.com/en/video/overview?source=video) and [fal](https://fal.ai/) to create an avatar livestreaming application.

## Features

- Uses the Vonage Video API [Broadcast](https://developer.vonage.com/en/video/guides/broadcast/overview?source=video) to stream to a Watch page as well as an RTMP endpoint (ie. YouTube, Twitch, LinkedIn, Facebook, etc.).
- The Vonage Video API [Archiving](https://developer.vonage.com/en/video/guides/archiving/overview?source=video) is used to record the stream.
- The Vonage Video API [Signaling](https://developer.vonage.com/en/video/guides/signaling?source=video) is used for the chat as well as send avatar commands from the Watch page.
- fal connects the WebRTC camera feed to [decart/lucy 2.5](https://fal.ai/models/decart/lucy-2-5/realtime/api) to apply live, real-time video editing.

## Get started

The easiest way to run this application is by using GitHub Codespaces. This sets up the entire environment automatically in your browser.

1. **Fork this repository** to your own GitHub account.
2. In your new fork, click the green **<> Code** button at the top right of the files list.
3. Select the **Codespaces** tab.
4. Click **Create codespace on main**.

Once the environment loads, the setup script will run automatically to configure your Vonage application!

The setup script will create the Vonage Application needed for the Video chat. It will ask for API Key and API Secret which can be found in the [Vonage Dashboard](https://dashboard.vonage.com)

The script will also ask for your fal API Key. You can find that in the [fal dashboard](https://fal.ai/dashboard/keys).
