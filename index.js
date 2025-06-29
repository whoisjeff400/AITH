import express from 'express';
import fetch from 'node-fetch';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs/promises';
import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const port = process.env.PORT || 3000;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// OAuth setup
const oauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  process.env.YOUTUBE_REDIRECT_URI
);

// 👇 Refresh token stored from earlier OAuth
oauth2Client.setCredentials({
  refresh_token: process.env.YOUTUBE_REFRESH_TOKEN
});

app.get('/render', async (req, res) => {
  try {
    // STEP 1 — Fetch latest script ready for rendering
    const { data: scriptRow, error } = await supabase
      .from('scripts')
      .select('id, topic')
      .eq('status', 'thumbed')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !scriptRow) throw new Error('No thumbed script found');

    const id = scriptRow.id;
    const topic = scriptRow.topic;

    // STEP 2 — Download assets
    const audioUrl = `${process.env.SUPABASE_STORAGE_BASE}/audio/${id}.mp3`;
    const thumbUrl = `${process.env.SUPABASE_STORAGE_BASE}/thumbnails/${id}.jpg`;

    const [audioRes, thumbRes] = await Promise.all([fetch(audioUrl), fetch(thumbUrl)]);
    const audioBuffer = await audioRes.arrayBuffer();
    const thumbBuffer = await thumbRes.arrayBuffer();

    await fs.writeFile(`./${id}.mp3`, Buffer.from(audioBuffer));
    await fs.writeFile(`./${id}.jpg`, Buffer.from(thumbBuffer));

    // STEP 3 — Render with FFmpeg
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(`./${id}.jpg`)
        .loop()
        .input(`./${id}.mp3`)
        .outputOptions('-shortest')
        .size('720x1280')
        .output(`./${id}.mp4`)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const videoBuffer = await fs.readFile(`./${id}.mp4`);

    // STEP 4 — Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from('videos')
      .upload(`${id}.mp4`, videoBuffer, {
        contentType: 'video/mp4',
        upsert: true,
      });

    if (uploadError) throw uploadError;

    // STEP 5 — Upload to YouTube
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    const youtubeRes = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: topic,
          description: `Auto-generated video about: ${topic}`,
        },
        status: {
          privacyStatus: 'public', // or 'unlisted'
        },
      },
      media: {
        mimeType: 'video/mp4',
        body: Buffer.from(videoBuffer),
      },
    });

    const youtubeVideoId = youtubeRes.data.id;

    // STEP 6 — Update DB
    await supabase.from('scripts').update({
      status: 'published'
    }).eq('id', id);

    res.json({
      status: '✅ published',
      video: `${id}.mp4`,
      youtube_id: youtubeVideoId,
      youtube_url: `https://www.youtube.com/watch?v=${youtubeVideoId}`
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => console.log(`🎬 FFmpeg + YouTube server running on port ${port}`));
