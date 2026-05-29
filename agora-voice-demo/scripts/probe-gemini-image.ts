// Probe: gemini-3.1-flash-image with the user's storybook prompt template.
// Save the returned image as PNG to /tmp so we can eyeball quality before
// wiring it into the lesson backend.

import { writeFileSync } from 'node:fs';
import { env } from './e1/lib/env.js';

const STYLE_PROMPT = `Minimalist hand-drawn children's storybook illustration for bedtime storytelling and imagination support.
A quiet printed picture-book page aesthetic designed to gently support imagination rather than overwhelm it.
Style:
colored pencil and dry watercolor illustration
hand-drawn black pencil outlines
loose imperfect sketch lines
visible textured paper fibers
soft matte paper surface
handcrafted analog feeling
subtle traditional print texture
slightly faded ink
uneven hand coloring
soft watercolor bleed
pigment gaps and rough coloring strokes
naive childlike simplicity
gentle asymmetry
scanned storybook page aesthetic
Composition:
centered composition
balanced visual weight
intimate framing
cozy storybook page layout
subject occupies the central 40-60% of the page
visual focus near center
moderate negative space
avoid giant empty margins
calm stable composition
emotionally warm page balance
picture-book spread feeling rather than poster layout
Background:
full-page warm terracotta paper tint
warm aged paper background
soft parchment paper tones
paper dyed with warm pigment
subtle warm vignette
background color embedded into the paper itself
gentle warm atmosphere across entire page
no stark white areas
Color Palette:
muted earthy tones
terracotta
dusty orange
warm beige
sage green
soft brown
low saturation
low contrast
no neon colors
no bright highlights
Narrative Language:
emotion expressed through posture and gesture
simple symbolic doodles floating between characters
dotted curved lines for imagination and conversation
small stars, moons, leaves, clouds, boats, animals
visual symbols should feel soft and minimal
illustration should guide imagination, not fully define it
Mood:
quiet
gentle
emotionally safe
bedtime atmosphere
cozy
warm
calm
breathable
nostalgic
intimate parent-child storytelling moment
Rendering Rules:
flat 2D storybook illustration
no cinematic lighting
no realistic rendering
no polished digital shading
no glossy surfaces
no vector cleanliness
no modern app illustration aesthetic
no hyper detail
no dynamic action composition
Avoid:
anime style, smooth gradients, clean vector art, shiny digital rendering, excessive texture overlays, strong grain noise, giant empty space, tiny characters, poster composition, UI onboarding illustration, cartoon TV style, highly detailed environments
Scene:`;

const SCENES = [
  'A quiet young boy looking up at the stars at night, holding a small pocket watch, wondering about time',
  'Two friends each holding identical clocks, one standing on the ground and the other floating in a small rocket ship above',
  'A child trying to chase a beam of golden light that keeps slipping away just beyond their reach',
];

async function main() {
  if (!env.geminiApiKey) {
    console.error('GOOGLE_API_KEY missing');
    process.exit(1);
  }

  for (let i = 0; i < SCENES.length; i++) {
    const sceneDesc = SCENES[i];
    const prompt = `${STYLE_PROMPT}\n[${sceneDesc}]`;
    console.log(`\n[scene ${i + 1}] generating: ${sceneDesc.slice(0, 60)}...`);
    const t0 = Date.now();

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=${env.geminiApiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });

    const latency = Date.now() - t0;

    if (!res.ok) {
      const errText = await res.text();
      console.error(`  ✗ HTTP ${res.status} after ${latency}ms: ${errText.slice(0, 300)}`);
      continue;
    }

    const data = (await res.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ inlineData?: { mimeType?: string; data?: string }; text?: string }>;
        };
      }>;
    };

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const inlineData = parts.find((p) => p.inlineData)?.inlineData;
    const text = parts.find((p) => p.text)?.text;

    if (!inlineData?.data) {
      console.error(`  ✗ no inline image data after ${latency}ms. Response keys:`, Object.keys(data));
      if (text) console.error(`     text part: ${text.slice(0, 200)}`);
      console.error(`     raw response (first 500 chars): ${JSON.stringify(data).slice(0, 500)}`);
      continue;
    }

    const buf = Buffer.from(inlineData.data, 'base64');
    const ext = inlineData.mimeType?.includes('png') ? 'png' : 'jpg';
    const outPath = `/tmp/gemini-image-scene${i + 1}.${ext}`;
    writeFileSync(outPath, buf);
    console.log(`  ✓ ${latency}ms — ${buf.length} bytes — saved ${outPath} (mime ${inlineData.mimeType})`);
  }
}

main().catch((err) => {
  console.error('probe fatal:', err);
  process.exit(1);
});
