// Storybook style prompt template for gemini-3.1-flash-image.
// Verbatim copy of the prompt validated by scripts/probe-gemini-image.ts —
// the same string MUST be reused by image-gen so cache keys match across the
// probe and the runtime path.

export const STORYBOOK_STYLE_PROMPT: string = `Minimalist hand-drawn children's storybook illustration for bedtime storytelling and imagination support.
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

/**
 * Build the full prompt for a single scene by appending the scene description
 * (wrapped in `[ ]` exactly as the probe validated) to the style template.
 *
 * The returned string is the *cache key source* — same scene description
 * always produces the same prompt, which always hashes to the same key.
 */
export function buildScenePrompt(sceneDescription: string): string {
  return `${STORYBOOK_STYLE_PROMPT}\n[${sceneDescription}]`;
}
