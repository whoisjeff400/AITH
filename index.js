import express from 'express';
import fetch from 'node-fetch';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs/promises';
import { createClient } from '@supabase/supabase-js';

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const port = process.env.PORT || 3000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.get('/render', async (req, res) => {
  try {
    // 1. Get the latest script
    const { data: scriptRow, error } = await supabase
      .from('scripts')
      .select('id')
      .eq('status', 'thumbed')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !scriptRow) throw new Error('No thumbed script');

    const id = scriptRow.id;

    // 2. Download thumbnail and audio
    const audioUrl = `${process.env.SUPABASE_STORAGE_BASE}/audio/${id}.mp3`;
    const thumbUrl = `${process.env.SUPABASE_STORAGE_BASE}/thumbnails/${id}.jpg`;

    const audioRes = await fetch(audioUrl);
    const thumbRes = await fetch(thumbUrl);

    const audioBuffer = await audioRes.arrayBuffer();
    const thumbBuffer = await thumbRes.arrayBuffer();

    await fs.writeFile(`./${id}.mp3`, Buffer.from(audioBuffer));
    await fs.writeFile(`./${id}.jpg`, Buffer.from(thumbBuffer));

    // 3. Render video using ffmpeg
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

    // 4. Upload to Supabase
    const { error: uploadError } = await supabase.storage
      .from('videos')
      .upload(`${id}.mp4`, videoBuffer, {
        contentType: 'video/mp4',
        upsert: true,
      });

    if (uploadError) throw uploadError;

    // 5. Update status
    await supabase.from('scripts').update({ status: 'ready' }).eq('id', id);

    res.json({ status: 'success', video: `${id}.mp4` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => console.log(`FFmpeg server listening on port ${port}`));
