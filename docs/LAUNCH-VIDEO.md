# Basher launch video — end to end

**Status:** draft 4, 2026-10-16. Nothing here is shot yet.
**Owner of the decisions:** Mrityunjay. Where a choice below is a recommendation and not a decision, it says so.
**Storyboard:** 27 sketched key frames, one per beat of §8, in [`launch/storyboard.html`](launch/storyboard.html). They are composition sketches; the interface in them is a placeholder.
**Tracking:** milestone "Launch Video", tracking issue #1608.
**What changed from draft 1:** the film inside the video is now a foot chase that ends in bullet time, not a quiet moment under a streetlamp. A car chase was considered and left out (§6.5).
**What changed from draft 3:** two beats move to a second cut of the video, made once the product can do them (decided 2026-10-16):

- **The one-sentence scene is out of this cut** (#1593). Getting the AI to build the whole chase predictably from one sentence needs more than this cut has time for. Level 1 now opens on the chase, prepared in advance and saved as a project, and the video never says or shows that a sentence made it. The prompt stays only on the competitor's side, in the cold open.
- **The procedural alley is out of this cut** (#1597, now in the Procedural Core milestone, #1659). Level 6 now swaps the whole set, from the alley to a plaza, and the replay shows that nothing placed in it moved.

**What changed from draft 2:** the first four checks were run in the app (#1600–#1603) and their results are folded in, beat by beat. In short:

- **The runner runs; it does not sprint.** Generated runs top out at 3.1–5.1 m/s against a real sprint's 7–9 (#1600). The film is written for a fast run and gets its pace from the cutting and the low camera (§6.2).
- **The AI's edit lands on Apply.** Level 7 now shows the review bar and the Apply click (#1602).
- **A placed light stays where it was put.** Decided 2026-10-14: the rim light does not travel with the runner (§2, beat 5.2).
- **"Same film. Every time." is not yet proven.** Restyling a rendered frame kept the pose but moved the figure and invented its own lights (#1601). The caption stays only if Basher's own scene-steered AI pass holds the frame (beat 8.2).
- **Bugs the checks found are fixed on local branches, not yet merged:** a moved character could not be clicked (#1610), the Light Brush died on a bone (#1611), the chat printed tool calls as JSON (#1612), the depth pass drew a T-pose (#1613).
- **New issues that matter for the capture** are listed in §12.2.

This document is the whole plan for the launch video: who it is for, what it claims, the story it tells, every shot, every caption, the sound, how it is captured, what the product must be able to do before the camera rolls, how it is cut down and released, and what can go wrong.

---

## 1. The one-page version

- **What it is:** a 110-second film of someone directing a twelve-second chase in Basher, in a browser tab.
- **Who it is for:** directors, and anyone who wants full control and authorship over their film.
- **The one idea:** Basher is _progressively granular_. You start with a scene. You can stop there. Or you can go down, level by level — the shots, the timing, a single fingertip, a single light, the whole world, the graph underneath — and nothing you already decided is lost on the way.
- **The image:** a bullet hanging in the air between a running figure's fingers while the camera travels around it.
- **Why that image:** freezing a moment and moving the camera through it, with everything exactly where it was, is the one thing a prompt-to-video tool cannot do. It is the control claim in a single frame.
- **The line:** _Direct your film. As far down as you want to go._
- **The tag:** _A procedural 3D film studio in your browser._
- **The proof:** every beat is real, unbroken screen capture.

---

## 2. Decisions

| Decision                                                                              | Taken by | Date       |
| ------------------------------------------------------------------------------------- | -------- | ---------- |
| The runner is the Sketchfab "Cyberpunk character" by 4d_Bob (CC-BY-4.0, credited)     | User     | 2026-10-16 |
| The pursuer is a rigged mecha firing a bullet or rocket, supplied by the user         | User     | 2026-10-16 |
| This cut opens on a prepared scene; the one-sentence scene waits for the second cut   | User     | 2026-10-16 |
| Level 6 swaps the set (alley to plaza); the procedural alley waits for the second cut | User     | 2026-10-16 |
| The launch speaks to a general audience: directors and anyone who wants full control  | User     | 2026-10-12 |
| The organising idea is "progressively granular"                                       | User     | 2026-10-12 |
| The video must stand out on ease of use                                               | User     | 2026-10-12 |
| The video must show fully controllable films                                          | User     | 2026-10-12 |
| The Light Studio is in the video                                                      | User     | 2026-10-12 |
| The film inside is an intense foot chase; the villain fires while the hero runs       | User     | 2026-10-12 |
| Bullet time, in slow motion, when the shot changes                                    | User     | 2026-10-12 |
| No car chase                                                                          | User     | 2026-10-12 |
| A placed light stays in the world; the rim light does not travel with the runner      | User     | 2026-10-14 |
| "World's first" is not put on screen (§5)                                             | Proposed | open       |
| The tag line is "a procedural 3D film studio in your browser"                         | Proposed | open       |
| No voiceover; captions carry the script                                               | Proposed | open       |
| The projectile is a bullet, not a stylised stand-in (§18)                             | Proposed | open       |

---

## 3. Audience

### 3.1 Who we are speaking to

**Primary — the director who has hit the control wall.** They already make shorts, ads, music videos or previs with prompt-to-video tools. They can get a beautiful clip. They cannot get _their_ clip: the one change they ask for changes everything else. They do not want to learn a 3D package.

**Secondary — anyone who wants authorship.** Animators, motion designers, 3D generalists and technical artists who want one place to build, animate, light and render with AI. They will watch the same video and read the lower levels as the promise meant for them.

### 3.2 What each of them must feel

| Viewer             | In the first 10 seconds    | By the middle                             | At the end                                   |
| ------------------ | -------------------------- | ----------------------------------------- | -------------------------------------------- |
| Director           | "That is my problem."      | "I could do that. It is one gesture."     | "I can make exactly the film I mean."        |
| 3D generalist      | "I know that frustration." | "That is real rigging and real lighting." | "It goes all the way down, and it is a tab." |
| Sceptic of AI film | "At least it is honest."   | "That is control, not a slot machine."    | "The work is theirs, not the model's."       |

### 3.3 What they must not feel

- That this is a 3D package they have to learn.
- That the depth is compulsory.
- That the AI is doing the directing.

---

## 4. Positioning

### 4.1 The promise

Start with a scene, go as deep as you want, never hit a wall, never lose what you already decided.

### 4.2 The four claims the video has to prove

1. **It is easy at the top.** Open the scene, press play, and you could stop there.
2. **It is controllable all the way down.** Shots, timing, performance, light, world, graph.
3. **It handles speed.** A fast, cut, multi-character sequence stays exactly as directed.
4. **The scene is the film.** What you direct in 3D is what the AI render delivers, and it is the same tomorrow.

### 4.3 Words we use and words we do not

| Use                             | Do not use in the video                    |
| ------------------------------- | ------------------------------------------ |
| film, shot, scene, performance  | DCC, pipeline, asset                       |
| direct, place, bend, light      | rig, bind, skin, weight                    |
| the world, the alley            | procedural generation, scatter, instancing |
| slow, freeze, the moment        | time remap, retime, speed ramp             |
| the graph (once, at the bottom) | DAG, node, socket, evaluator               |
| ask, undo                       | agent, tool call, MCP                      |
| in your browser                 | WebGPU, no install required                |

"Procedural" appears exactly once, in the closing tag, where it is a category word for the people who search for it.

---

## 5. The field, and what we can honestly claim

A check of competitors' own sites and trade coverage on 2026-10-12. None of it is hands-on testing; re-check before quoting any of it in public.

| Product              | How it presents itself                                                             | Where it stops, by its own pages                                                    |
| -------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Intangible           | Browser AI 3D studio; "the world's simplest AI 3D tool"                            | Not a modelling package; no rigging, bone posing or procedural tools mentioned      |
| Autodesk Flow Studio | 3D Editor for scenes, cameras and timelines, plus a node canvas of AI video models | The nodes are on the AI side; nothing found on procedural scene building            |
| Higgsfield 3D Jutsu  | Prompt to an editable 3D scene, then video                                         | No rigging or procedural tools mentioned                                            |
| CozyClay             | Open-source browser previs: block, pose, cut, hand off to a video model            | No rigging, weights or procedural tools                                             |
| Mixos                | "The whole 3D pipeline, in one browser tab"; rig, keys, physics, a chat agent      | Sells assets you export, not films; AI video undescribed                            |
| Mixar                | "Anything 3D, with Agents"; a desktop editor built on Blender                      | Desktop download; AI video is a separate media result; agent edits sit outside undo |

**What follows from it**

- "World's first browser-based 3D-to-AI-video tool" is false. Four products do it.
- "First browser 3D studio with rigging and animation" is false. Mixos claims it.
- "Easiest" is contested. Intangible uses "world's simplest".
- "Agent-native 3D editor" is Mixar's headline.
- Nobody found puts _procedural_, _film_ and _browser_ together on their front page. That is not proof of being first. It is the open space.

**So the video claims by showing, not by saying.** The four things no competitor page shows:

1. A frozen moment re-shot from a new camera with nothing regenerated (§8, level 3).
2. A change to the whole world, a new set, that leaves a fine detail intact (§8, level 6).
3. One undo across the director's edits and the AI's (§8, level 7).
4. The light you placed in 3D surviving into the AI render (§8, level 8).

---

## 6. The film inside the video

### 6.1 Why a film inside the video

A feature tour asks the viewer to imagine the use. A small film lets them watch a sequence get sharper with each decision. Every control beat is a creative choice in that film.

### 6.2 The film

**Title (working):** _Miss_.
**Length:** twelve seconds, three shots.
**Logline:** a runner races down a night alley; behind them a pursuer raises a gun and fires; time slows, and the bullet passes between the runner's fingers.

| Shot | Seconds | What happens                                                                                                                                                                  |
| ---- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | 0–4     | Low, fast tracking shot beside the runner, close enough that the walls streak. Feet, breath. Pace comes from the lens and the cut, not the runner's top speed (§6.4).         |
| B    | 4–6     | Cut. The pursuer at the alley mouth plants their feet, raises the gun, fires. Muzzle flash.                                                                                   |
| C    | 6–12    | Cut. Time drops to almost nothing. The camera travels from behind the bullet, around the runner's trailing hand, to their face. Time snaps back; the bullet strikes the wall. |

### 6.3 Why this film

- **It needs every level of control.** Three shots and their cuts, a speed change, two performances, a fingertip, a light that is part of the story, a world that extends, a look.
- **Bullet time is the claim in one image.** The same moment, a new camera, nothing regenerated.
- **It proves speed.** A fast, cut sequence with two characters is the hardest thing to keep consistent in a prompt tool.
- **The fingertip beat becomes the peak.** The bullet passing between two fingers is the frame people will remember.
- **The muzzle flash makes the Light Studio part of the story,** not decoration.
- **It is wordless,** so it plays everywhere, muted.

### 6.4 Art direction of the inner film

- **Runner and pursuer:** stylised, not photoreal. Two silhouettes that cannot be confused at thumbnail size: different build, different colour temperature. Hands large enough for the finger beat to register. Not the test dummy.
- **Alley:** narrow, tall, repeating frontage with fire escapes, bins and doorways; wet ground for reflections if it is cheap.
- **Bullet:** slightly oversized and bright, with a short trail, so it reads on a phone.
- **Speed (measured, #1600):** generated runs reach 3.1–5.1 m/s and every clip starts from a standstill, with 1.3–1.7 s of wind-up. So the runner's clip is trimmed past the wind-up and played about 1.5 times faster, the camera sits low and close, and shot A is cut before the runner's lack of a true sprint shows. One generation also covers at most about 16 m of ground (measured 2026-10-14), so shot A stays at or under about 3.5 s of travel or is built from two generations.
- **Palette:** sodium orange and deep blue; the muzzle flash is the only white.
- **Aspect:** 2.39:1 inside the viewport for the final playback, so it looks like cinema, not like a tool.

### 6.5 What was left out, and why

**A car chase in the first half.** Left out by decision on 2026-10-12, for three reasons:

- Nothing on main supports vehicles: no physics engine, no wheels that turn, no suspension or steering. A car would be a keyframed box and would look like one.
- A hundred and ten seconds carries one sequence properly. Two means neither gets the hold that makes bullet time land.
- A foot chase already proves "fast-paced": speed on screen comes from cutting and camera.

Vehicles make a strong second video once mechanical rigs exist (wheels and suspension are planned in the rigging milestone, #1374).

---

## 7. Structure

| Part                      | Time      | Job                                                             |
| ------------------------- | --------- | --------------------------------------------------------------- |
| Cold open: the wall       | 0–9 s     | Name the pain in the viewer's own experience                    |
| Level 1: the scene        | 9–22 s    | Ease: open the scene, one watchable chase, "stop here"          |
| Level 2: the shots        | 22–32 s   | Three shots, a camera dragged by hand, a cut moved              |
| Level 3: the timing       | 32–44 s   | Everything slows together; the camera travels the frozen moment |
| Level 4: the performance  | 44–56 s   | A head, a shoulder, then a fingertip                            |
| Level 5: the light        | 56–66 s   | Light Studio: place the flash, drag a rim, key it               |
| Level 6: the world        | 66–73 s   | The set changes from alley to plaza; nothing placed is lost     |
| Level 7: the collaborator | 73–80 s   | Ask the AI; one undo for both of you                            |
| Level 8: the look         | 80–88 s   | AI render: two looks, the same frame                            |
| The bottom                | 88–93 s   | The graph: every decision is still there                        |
| The film                  | 93–105 s  | The finished twelve seconds, uninterrupted                      |
| Close                     | 105–111 s | Name, line, tag, URL                                            |

**The rhythm:** the video itself moves like its subject. Levels 1 and 2 are quick. At level 3 the edit slows with the picture and stays slow through the fingertip. It accelerates again from level 6 and hits full speed for the finished film.

**The two rests:** "You could stop here" appears after level 1 and again after level 5. They are the ease-of-use claim. Do not cut them for time.

---

## 8. Shot-by-shot script

Conventions: **Screen** is what is captured. **Action** is what the hand does. **Caption** is the exact on-screen text. **Sound** is the cue. **Needs** is the product behaviour the shot depends on.

### Cold open — the wall (0–9 s)

**Shot 0.1 (0–4 s)**

- **Screen:** a generic, unbranded prompt box on a dark page. Not a real competitor's interface.
- **Action:** typed, at human speed: "A man sprints down an alley at night. Someone fires at him." A clip plays. It is nearly right.
- **Caption:** none.
- **Sound:** room tone, keystrokes.
- **Needs:** two pre-generated clips made with any prompt-to-video model, cleared for this use.

**Shot 0.2 (4–7 s)**

- **Action:** typed: "slow down at the gunshot." A new clip replaces the first: a different alley, a different man, no gun.
- **Caption:** none.
- **Sound:** one flat, wrong note.

**Shot 0.3 (7–9 s)**

- **Screen:** hold on the wrong clip. It dims.
- **Caption:** _You asked for one change._
- **Sound:** silence.

### Level 1 — the scene (9–22 s)

**Shot 1.1 (9–12 s)**

- **Screen:** a browser window. The address bar is visible for one second, then the view pushes in to the Basher viewport with the chase project open, paused on its first frame.
- **Caption:** _Start with a scene._ (proposed wording)
- **Sound:** a single low pulse.
- **Needs:** the demo project (§11.2) opening cleanly, with no panels open and no starter objects in it.

**Shot 1.2 (12–18 s)**

- **Action:** play is pressed. The chase plays once at full speed, bullet and all.
- **Caption:** none.
- **Sound:** running feet, a shot.
- **Needs:** the prepared chase: the alley, two characters with their own motion, a fired projectile and a camera, saved as a project and playing at full speed in one take.
- **Honesty (decided 2026-10-16):** the scene is prepared in advance. Nothing in this beat, the captions or the post says or implies that a sentence made it. Building a scene from one sentence is a second-cut beat (#1593).
- **Checked (#1600):** two characters with one generated motion each play together without errors, and the draw-and-fire reads clearly as aiming. A dropped motion binds only to the character that is selected, so any step that adds motion by hand selects the character first. Making it from one sentence was measured on #1593 and moved to the second cut.

**Shot 1.3 (18–22 s)**

- **Action:** the director orbits the viewport once, a third of a turn, and comes back.
- **Caption:** _You could stop here._
- **Sound:** a beat of quiet.

### Level 2 — the shots (22–32 s)

**Shot 2.1 (22–26 s)**

- **Screen:** the shots panel on the right, three shots listed with thumbnails: the run, the gun, the bullet.
- **Action:** the first shot is selected. Its camera path is grabbed in the viewport and dragged down to knee height, tight on the runner.
- **Caption:** _The shots._
- **Sound:** percussion enters.
- **Needs:** a shots panel listing the scene's shots; a camera path draggable in the viewport, updating live.

**Shot 2.2 (26–29 s)**

- **Action:** the second shot is selected. Its camera is keyed closer to the gun across the shot — a push in — and the camera drives toward it while its aim holds.
- **Caption:** none.
- **Needs:** nothing new. A push-in is the camera's own keys, as in Blender, which has no move picker either. Observed 2026-10-17 in the plaza scene: the camera eased from 3.19 m to 2.23 m from the runner over two seconds, aim held (`plaza-run-v2.basher`). The picker (#1596) was closed as not needed.

**Shot 2.3 (29–32 s)**

- **Action:** on the timeline, the cut between the gun and the bullet is dragged two frames earlier, to land on the flash. The three shots play through.
- **Caption:** _The cut._
- **Sound:** the cut lands on a drum hit.
- **Needs:** cut points editable on the timeline.

### Level 3 — the timing (32–44 s)

**Shot 3.1 (32–37 s)**

- **Screen:** the timeline, a single speed line across the whole scene.
- **Action:** at the gunshot, the line is pulled down almost to zero. In the viewport both figures, the bullet and the flash slow together and hang.
- **Caption:** _The timing._
- **Sound:** the music and the footsteps bend down in pitch and stop. One held tone.
- **Needs:** one control that slows the whole scene at once — every character, the projectile and the lights — not one clip at a time.

**Shot 3.2 (37–44 s)**

- **Action:** in the hanging moment, the third shot's camera path is drawn as an arc: from behind the bullet, around the runner's trailing hand, to their face. The shot plays. Nothing in the scene has moved except the camera.
- **Caption:** _Change the shot. Keep the moment._
- **Needs:** a camera path that plays in real time while scene time is nearly stopped.
- **This is the centrepiece.** It gets the longest unbroken take in the video.

### Level 4 — the performance (44–56 s)

**Shot 4.1 (44–49 s)**

- **Screen:** still inside the frozen moment, on the runner.
- **Action:** the head is turned back over the shoulder. The shoulder is pulled out of the bullet's line.
- **Caption:** _The performance._
- **Needs:** posing a bone in the viewport on a character that is mid-clip, starting from the pose on screen.

**Shot 4.2 (49–56 s)**

- **Screen:** the view pushes in on the trailing hand until it fills a third of the frame. The bullet is a hand's width away.
- **Action:** two fingers are spread, one at a time, until the bullet's path runs between them. The other fingers do not move.
- **Caption:** _Down to a fingertip._
- **Sound:** the held tone, alone.
- **Needs:** finger bones that move only their own finger. **Verified in the app on 2026-10-12** on a re-bound imported character: bending one finger moved no vertex of the neighbouring fingers by more than a millimetre.
- **Hold:** two full seconds on the finished frame. This is the image people will remember.

### Level 5 — the light (56–66 s)

**Shot 5.1 (56–60 s)**

- **Screen:** the Light Studio opens beside the viewport.
- **Action:** with the Light Brush, a click on the runner's cheek. A hard white light lands exactly there: the muzzle flash reaching them.
- **Caption:** _The light._
- **Sound:** a bright, short chord.
- **Needs:** the Light Brush placing a light from a click on the model, on the hero character.
- **Checked (#1603):** on a moving imported character the light lands exactly on the mirror direction from the click, and the stroke is one undo step. That was measured with two workarounds a user can't do: the skeleton hidden, and the character's click region refreshed by hand. Two fixes on local branches, not yet merged, remove the need for them: a character that has moved could not be clicked (#1610), and a click that landed on a bone selected the skeleton and left the brush dead (#1611).
- **For the capture:** with the Light Studio open at 1600×900 only about 450 px of viewport height is clear (#1617), and the viewport gives no sign that the brush is on (#1615). Frame the cheek high in the viewport and turn the brush off before leaving the panel.

**Shot 5.2 (60–63 s)**

- **Action:** a puck is dragged around the studio sphere. A cold rim light travels along the runner's back and settles.
- **Caption:** none.
- **Needs:** a puck drag that moves the light live and is one undo step.
- **Checked (#1603):** a 12-step drag is one undo step, and one undo puts the light back exactly.
- **The light stays where it is put (decision, 2026-10-14).** It is placed inside the frozen moment, so it rims the runner where they hang. At full speed the runner runs through it rather than carrying it along, which is right for a light that belongs to the alley. Nothing in this beat waits on a light that follows a character (#1614, out of the milestone).

**Shot 5.3 (63–66 s)**

- **Action:** the flash's brightness is keyed at the gunshot. Played in slow motion, the white light blooms across the wall and dies.
- **Caption:** _You could stop here, too._
- **Needs:** a light's brightness keyed from the panel, playing correctly through the slowed section.
- **Checked (#1603):** keyed from the panel at 0 → 80 → 0 over a quarter of a second, it plays and scrubs correctly, and the cheek's brightness goes from 9 to 246 out of 255. Playing it through slow motion waits on the scene-wide speed control (#1594).

### Level 6 — the world (66–73 s)

**Shot 6.1 (66–71 s)**

- **Screen:** the view pulls back above the alley.
- **Action:** the set is swapped in one gesture: the alley goes, and a night plaza takes its place. The runner, the pursuer, the bullet, the lights and the cameras stay exactly where they are.
- **Caption:** _The world._
- **Sound:** the music returns, building.
- **Needs:** the plaza as a set the chase project can take in place of the alley, in one gesture that is one undo step. The runner's path, the pursuer's position and the bullet's line have to make sense in the plaza too, including a wall for the bullet to hit (7.1).
- **Decided 2026-10-16:** a set swap replaces the one-slider alley in this cut. The plaza was built and saved during the alley-run tests; swapping it into the chase project has not been tried (#1662). The procedural alley is a second-cut beat (#1597).

**Shot 6.2 (71–73 s)**

- **Action:** a quick replay of the bullet-time shot. The pose, the light and the fingertip are exactly as they were.
- **Caption:** _Change everything. Lose nothing._
- **Needs:** the performance and lighting surviving the set swap, with no visible pause.

### Level 7 — the collaborator (73–80 s)

**Shot 7.1 (73–76 s)**

- **Action:** typed into the chat: "add sparks where the bullet hits the wall." The chat answers in a line ("Added sparks"), a review bar appears over the viewport, and Apply is clicked. Sparks burst at the impact point.
- **Caption:** _Ask._
- **Sound:** a ricochet.
- **Needs:** the AI adding an animated effect at a point it has to work out from the scene.
- **Checked (#1602):** the AI's change waits on a review bar and lands on Apply. The beat is "ask, Apply", not "ask". After #1612 (fixed locally) the chat and the review bar describe the change in a plain sentence instead of printing tool calls.

**Shot 7.2 (76–80 s)**

- **Action:** undo — the sparks go. Undo — the alley is back. Redo, redo — the plaza and the sparks return.
- **Caption:** _Or take it back. Yours and the AI's, one undo._
- **Sound:** two clicks back, two forward.
- **Needs:** the AI's edit and the director's edit in the same undo history, each one step.
- **Verified (#1602):** a hand edit and an applied AI turn are two undo steps; undo, undo, redo, redo gives back each scene exactly, compared as text.

### Level 8 — the look (80–88 s)

**Shot 8.1 (80–84 s)**

- **Screen:** the frozen fingertip frame.
- **Action:** an AI look is applied: graphic-novel ink. The highlight sits on the cheek; the bullet is between the fingers.
- **Caption:** _The look._
- **Needs:** an AI render pass driven by the 3D scene, holding the pose and the placed light.

**Shot 8.2 (84–88 s)**

- **Action:** a second look: photoreal night. Same frame, same performance.
- **Caption:** _Same film. Every time._ **Conditional.** Not yet proven; see below.
- **Needs:** a second look over the same scene, visibly the same blocking.
- **Checked, outside Basher (#1601):** restyling a rendered frame with a hosted image model kept the pose and the hand gesture, but drew the figure about a third larger and higher, and invented its own lamps. A restyle from the picture alone does not carry the claim. It needs Basher's own AI pass, steered by the scene's depth and normal passes, which has not been run: there is no ComfyUI on the test machine, and the depth pass drew a T-pose until #1613 (fixed locally).
- **If the scene-steered pass does not hold the frame,** the caption goes and level 8 ends on one look as a finishing pass (§12.6).
- **Honesty rule:** if a look took minutes to render, the cut says so with a small "rendered in N min" label, or the wait is shown as a labelled time-lapse. No pretending it is instant.

### The bottom (88–93 s)

**Shot 9.1 (88–93 s)**

- **Action:** the viewport pulls back and the scene dissolves into its graph. Each decision made above lights up in the order it was made: scene, shots, speed, pose, light, set, sparks, look.
- **Caption:** _All the way down. Or not at all._
- **Sound:** the music thins to one pulse.
- **Needs:** a read-only graph view of this project, legible at 1080p, with readable names.

### The film (93–105 s)

**Shot 10.1 (93–105 s)**

- **Screen:** the finished twelve-second film, full-frame, letterboxed, no interface. The run, the gun, the freeze, the fingers, the wall.
- **Caption:** none.
- **Sound:** the film's own sound only: feet, breath, the shot, silence in the freeze, the ricochet.

### Close (105–111 s)

**Shot 11.1 (105–109 s)**

- **Screen:** black.
- **Caption:** **Basher** — _Direct your film. As far down as you want to go._
- **Sound:** silence.

**Shot 11.2 (109–111 s)**

- **Caption:** _A procedural 3D film studio in your browser._ and the URL.
- **Sound:** the final pulse.

---

## 9. Caption sheet

Every word that appears on screen, in order. Nothing else is written on the picture.

1. _You asked for one change._
2. _Start with a scene._ (proposed wording)
3. _You could stop here._
4. _The shots._
5. _The cut._
6. _The timing._
7. _Change the shot. Keep the moment._
8. _The performance._
9. _Down to a fingertip._
10. _The light._
11. _You could stop here, too._
12. _The world._
13. _Change everything. Lose nothing._
14. _Ask._
15. _Or take it back. Yours and the AI's, one undo._
16. _The look._
17. _Same film. Every time._ (conditional: only if beat 8.2 is proven)
18. _All the way down. Or not at all._
19. **Basher** — _Direct your film. As far down as you want to go._
20. _A procedural 3D film studio in your browser._

**Caption rules**

- One typeface, one weight, lower third, left-aligned.
- The level names (4, 6, 8, 10, 12, 14, 16) share one style, so the descent is read as a list being ticked off.
- No caption is on screen for less than 1.5 seconds.
- No exclamation marks, no emoji, no feature names.

---

## 10. Sound and music

- **Music:** percussive and driving from level 1, built for a chase. At level 3 it bends down in pitch with the picture and stops, leaving one held tone through the frozen moment and the fingertip. It returns at level 6 and reaches full weight for the finished film.
- **The inner film's sound** exists from level 1: feet, breath, the shot. In the freeze there is near silence. The ricochet arrives with the sparks.
- **Interface sounds:** none added. Real key and click sounds only where a gesture needs to be felt (the two undo clicks).
- **No voiceover.** The video must work muted in a feed and loud in a room.
- **Licensing:** original or fully cleared music. Record who made it and under what terms.

---

## 11. What must be made before shooting

### 11.1 Assets

| Asset             | Requirement                                                              | State                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner            | Stylised, rigged, with finger bones; a licence that allows marketing use | Chosen 2026-10-16: "Cyberpunk character" by 4d_Bob, CC-BY-4.0 (credit owed); 56 joints, 30 of them finger joints. Its run (ActorCore) is not yet paid for |
| Pursuer           | A second figure, clearly different in silhouette and colour              | Chosen 2026-10-16: a rigged mecha firing a bullet or rocket; the user supplies it                                                                         |
| Gun and bullet    | Simple, slightly oversized; the bullet with a short trail                | Not built                                                                                                                                                 |
| Alley             | A night alley set                                                        | Built in Blender for the alley-run tests; static                                                                                                          |
| Plaza             | A night plaza set the alley can be swapped for                           | Built and saved during the alley-run tests; not yet a set the chase can take                                                                              |
| Run               | A fast run that reads at knee height                                     | Generated runs checked: usable trimmed and sped up (#1600)                                                                                                |
| Draw-and-fire     | Plant, raise, fire, recoil                                               | Not chosen                                                                                                                                                |
| Sparks            | A short burst at a point                                                 | Not built                                                                                                                                                 |
| Two AI looks      | Graphic-novel ink and photoreal night, both stable across twelve seconds | Not chosen                                                                                                                                                |
| Two "wrong" clips | For the cold open, cleared for use                                       | Not made                                                                                                                                                  |
| Music             | About 110 seconds, cleared                                               | Not commissioned                                                                                                                                          |

### 11.2 The demo project

One saved Basher project holds the whole shoot, with a checkpoint per level, so any beat can be re-shot without redoing the ones before it.

---

## 12. What Basher needs before this can be shot

Surveyed on main at `707cb2da` on 2026-10-12, by reading the code and the open issues. "In the code" means the feature was found in the repository. It does **not** mean it was run. Only one beat has been observed working in the app.

### 12.1 Must be built

| #   | What                                                            | For beat | On main today                                                                                                                                                                           |
| --- | --------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ~~A scene from one sentence~~: **second cut** (#1593)           | 1.2      | The AI has separate tools (add a mesh, import from the library, generate a model, generate motion, walk-to, create a shot, move a camera). Nothing found chains them from one sentence. |
| 2   | One control that slows the whole scene                          | 3.1, 5.3 | Per-clip retiming exists. No scene-wide speed control was found.                                                                                                                        |
| 3   | A shots panel, and cuts editable on the timeline                | 2.1, 2.3 | Shot and Cut nodes exist and the AI can create a shot. No panel was found.                                                                                                              |
| 4   | ~~A camera move picker~~: **not needed** (#1596 closed)         | 2.2      | Blender has no move picker; a push-in is keyed on the camera. Done that way in the plaza scene on 2026-10-17.                                                                           |
| 5   | ~~An alley driven by one length value~~: **second cut** (#1597) | 6.1      | Array and Scatter operators exist. No set built from them does.                                                                                                                         |
| 6   | Sparks, or any short burst effect                               | 7.1      | No particle system was found.                                                                                                                                                           |
| 7   | A read-only graph view                                          | 9.1      | Not built. Planned as the last step of the Graph milestone (#1563), after stored node positions (#1562).                                                                                |
| 8   | Applying an AI look in one gesture                              | 8.1, 8.2 | AI, depth, normal and ID passes and the ComfyUI handoff exist, with one look preset. No one-click control was found.                                                                    |

### 12.2 Issues already filed, and how each relates

Re-read on 2026-10-12 against the script. None of these blocks filming; an earlier draft of this section overstated them.

| Issue        | What it is                                                                     | Needed?                                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1563        | A read-only node view (after #1562, stored node positions)                     | Only if the six-second graph shot stays in the video (open decision 7)                                                                                                                                                       |
| #1281        | A saved scene does not carry its imported assets                               | Not to film in one browser. Yes to publish the demo project, or to move the shoot to another machine                                                                                                                         |
| #1048, #1047 | An imported textured piece with a modifier is not drawn, or takes down the app | Only if the alley is built from imported textured pieces under an Array or Scatter; check under the alley work                                                                                                               |
| #1463        | The dope sheet shows 7 of a character's 1,407 rows                             | No. The script never opens the dope sheet                                                                                                                                                                                    |
| #1492        | The timeline panel can't be resized                                            | No. Nice for framing the timeline                                                                                                                                                                                            |
| #1500        | The layer panel's empty state shows AI tool names                              | No. Only visible if that empty panel is on screen; covered by the vocabulary walk                                                                                                                                            |
| #1399        | A second motion cannot be layered over a character's first                     | Conditional on the pursuer's rig (2026-10-16). If the mecha's fire comes keyed, or is keyed by hand, the recoil is in the same keys and this is not needed. If the fire is generated, a hand-keyed recoil over it needs this |
| #1475        | "Generate, tweak by hand, done, as one non-destructive graph"                  | A related goal, not a dependency. Nothing in the script waits on it                                                                                                                                                          |

**Found by the checks and the alley tests, 2026-10-12 to 14.** "Fixed locally" means fixed and tested on a local branch that is not yet merged.

| Issue        | What it is                                                                                                  | Needed?                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| #1594        | No way to slow the whole scene at once                                                                      | Yes. It is build item 2 and the centrepiece                                                  |
| #1610        | A character that has moved can't be clicked                                                                 | Yes, for any click on the running character (4.1, 5.1). Fixed locally                        |
| #1611        | The Light Brush dies when a click lands on a bone                                                           | Yes, for 5.1. Fixed locally                                                                  |
| #1612        | The chat prints the AI's tool calls as JSON                                                                 | Yes, for 7.1. Fixed locally                                                                  |
| #1613        | The depth pass draws a posed character in its T-pose                                                        | Yes, for 8.1 and 8.2. Fixed locally                                                          |
| #1631        | A rendered animation draws the light helpers into every frame                                               | Yes, for any rendered shot with point lights. Fixed locally                                  |
| #1632–#1635  | A generated motion on an imported rig: wrong bones, short of its path, facing wrong                         | Yes, for the runner on a path. Fixed locally                                                 |
| #1615        | The Light Brush gives no sign in the viewport that it is on                                                 | Not to film; it is a trap while rehearsing                                                   |
| #1616, #1617 | The Light Studio's list and settings are clipped; the viewport is a strip                                   | Not to film if framed for it; it shows in 5.1–5.3                                            |
| #1624–#1627  | Toolbar under the inspector; internal ids as names; half the window for viewport; advanced controls in view | For the capture: every one of them is on screen in some beat. See the vocabulary risk in §18 |

### 12.3 Must be verified, and fixed if it fails

| Beat     | What it needs                                             | Evidence today                                                                                                                             | State                                                           |
| -------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| 1.2      | A generated run and a draw-and-fire that look right       | Runs top at 3.1–5.1 m/s from a standstill; the aim reads, no recoil (#1600)                                                                | Checked: usable with a trim, a speed-up and a hand-keyed recoil |
| 1.2      | Two characters in one scene, each with its own motion     | Both play together; a dropped motion binds to the selected one (#1600)                                                                     | **Verified**                                                    |
| 2.1      | Drag a camera path in the viewport                        | Curves, follow-path and camera moves exist                                                                                                 | In the code, not run                                            |
| 3.2      | A camera path playing while scene time is nearly stopped  | Depends on build item 2                                                                                                                    | Not verified                                                    |
| 4.1      | Pose a head and shoulder mid-clip from the pose on screen | Pose mode and the bone gizmo are closed issues with their own tests                                                                        | In the code, not run                                            |
| 4.2      | Spread two fingers without moving their neighbours        | Measured in the running app, 2026-10-12                                                                                                    | **Verified**                                                    |
| 5.1      | Light Brush places a light from a click                   | Lands on the mirror direction on a moving character, measured with two workarounds (#1603); #1610 and #1611 remove them, tested separately | **Verified** with workarounds; rerun after merge                |
| 5.2      | Drag a light puck, one undo step                          | 12-step drag, one undo step, exact restore (#1603)                                                                                         | **Verified**                                                    |
| 5.3      | A keyed light brightness, correct through slow motion     | Keyed brightness plays and scrubs (#1603); slow motion waits on #1594                                                                      | Half verified                                                   |
| 6.1      | The plaza swapped in for the alley in one gesture         | The plaza is saved as its own project; never swapped into the chase                                                                        | Not verified                                                    |
| 6.2      | Pose and light survive the set swap                       | Follows from the graph; never tried on this scene                                                                                          | Not verified                                                    |
| 7.2      | One undo across the director's and the AI's edits         | Two steps, exact restore both ways; the AI's edit lands on Apply (#1602)                                                                   | **Verified**                                                    |
| 8.1, 8.2 | The look keeps the placed light and the pose              | A restyle outside Basher keeps the pose, loses framing and light (#1601); Basher's own pass not run                                        | **Not proven**                                                  |

### 12.4 Not needed for this video

Considered and left off the launch path. Each is a large build and none appears on screen.

| Item                                    | On main today                                      | Why it is not on the path                                                 |
| --------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------- |
| An editable node editor                 | Not built; not in the Graph milestone              | The video needs only a six-second read-only view                          |
| Materials written in a shading language | Not built; nothing on main uses the newer renderer | No shot depends on it                                                     |
| An in-app AI node graph                 | Not built                                          | The look is one gesture in the script; a graph would break the ease claim |
| Vehicles and physics                    | Not built                                          | The car chase is out (§6.5)                                               |

### 12.5 The order to check and build

1. **Scene-wide slow motion (item 2).** Without it there is no bullet time; this is the centrepiece.
2. **The AI look keeping light and pose (beats 8.1, 8.2).** It decides whether the fourth claim is true.
3. **Two characters with generated run and fire motions.**
4. **The shots panel and cuts (item 3).**
5. **The set swap (beats 6.1, 6.2).**
6. **The conditional issues in §12.2,** once the choices they hang on are made.
7. **Everything marked "in the code, not run",** in one sitting, on the demo project.
8. **Sparks, the look control, the graph view (items 6, 8, 7).**

Items 1 and 5 of §12.1 (the one-sentence scene and the procedural alley) are in the second cut.

### 12.6 What each failure costs

| If this fails                | Then                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| One-sentence scene           | Taken (2026-10-16): level 1 opens on the prepared scene. The ease claim is weaker; the descent still holds. |
| Scene-wide slow motion       | No bullet time. Fall back to a hard freeze on one frame with a camera move around it; weaker, still unique. |
| Shots panel                  | Show the three shots on the timeline only. Lose "on the right", keep the cuts.                              |
| Set swap                     | Cut level 6 and its caption. Keep 7.2 on the sparks and one hand edit.                                      |
| Sparks                       | Ask the AI for "a flash of light where it hits" instead. Uses lights, which exist.                          |
| Shared undo                  | Cut 7.2. Keep "Ask". This loses a claim no competitor makes — fix the product if at all possible.           |
| The look keeps the light     | End level 8 at one look as a finishing pass; drop "Same film. Every time."                                  |
| Graph view                   | Cut the bottom. End the descent at the look; the last caption moves to the close.                           |
| Hero figures not good enough | Do not shoot. The last twelve seconds are the film itself.                                                  |

---

## 13. Capture

- **Resolution:** record at 3840×2160, deliver at 1920×1080 and 3840×2160. Recording large allows push-ins in the edit without re-shooting.
- **Frame rate:** 60 fps capture, 30 fps delivery. The slow motion is done by Basher, in the scene, never by slowing the recording.
- **Browser:** one clean profile, no extensions, no bookmarks bar, system dark mode.
- **Cursor:** enlarged slightly; no click-highlight effects.
- **Interface zoom:** raised so panel text is legible at 1080p on a phone.
- **Privacy:** no account name, email, file path or project ID on screen.
- **One take per beat.** A beat that needs a cut inside it is not ready.
- **Rehearse to a metronome.** Each gesture has a count, so the edit lands on the music without speeding footage up.
- **No sped-up footage** except where a wait is shown honestly as a labelled time-lapse.
- **Keep the raw takes.** They are the answer when someone says it was faked.

---

## 14. Edit and finish

- **Cuts** fall only between beats.
- **Push-ins** are done in the edit on the 4K capture, never by zooming the interface live, except the hand in 4.2, which is a real viewport move.
- **Colour:** the interface is left as it is. Only the final film playback is graded.
- **Transitions:** hard cuts throughout, one dissolve (scene into graph), one cut to black before the close.
- **Captions:** burned in, plus a subtitle file with the same text for accessibility.
- **Loudness:** mixed for phone speakers first. The gunshot is not louder than the music; it is sharper.

---

## 15. Cut-downs

| Cut            | Length  | Contents                                                             | For                        |
| -------------- | ------- | -------------------------------------------------------------------- | -------------------------- |
| Full           | 110 s   | Everything                                                           | Site, YouTube, launch post |
| Social         | 30 s    | Cold open (5 s), level 1, the freeze and orbit, the fingertip, close | Feeds                      |
| Vertical       | 30 s    | Same as social, reframed 9:16 on the viewport                        | Shorts, Reels, TikTok      |
| Loop           | 8 s     | The orbit around the hanging bullet, ending on the fingers           | Site hero, silent          |
| One per level  | 10–15 s | Each level alone with its caption                                    | A week of follow-up posts  |
| The film alone | 12 s    | _Miss_, no interface                                                 | "Made in Basher"           |

The loop is the thumbnail in motion. If only one frame of the whole project is seen, it is the bullet between the fingers.

---

## 16. Release

Proposals, not decisions.

- **Title:** "Basher — direct your film, as far down as you want to go."
- **Thumbnail:** the bullet between two fingers, white on orange and blue, no text or two words at most.
- **First line of the post:** "You asked for one change. This time you get one change."
- **The landing page** mirrors the video: the same eight levels as eight short sections, each with its own loop, each ending "you could stop here" or "go deeper".
- **A page for the people who want proof:** the raw takes, the demo project to open in a tab, and the list of what was verified.
- **Comparison pages** by name, written from each competitor's own published limits, updated whenever they ship.
- **Sequence:** the full video first; one level a day after it.

---

## 17. Claims check

Every claim the video makes, and what makes it true.

| Claim, as shown                               | True when                                                                                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Open the scene and it plays                   | Beat 1.2 is one unbroken take of the saved project                                                                                  |
| It runs in a browser                          | The address bar is on screen in 1.1 and the take continues                                                                          |
| Slow the whole scene with one control         | Beat 3.1 is one drag, and every moving thing slows together                                                                         |
| Re-shoot a frozen moment from anywhere        | Beat 3.2: only the camera changes between two plays of the same moment                                                              |
| You can control a fingertip                   | Beat 4.2 — verified                                                                                                                 |
| You can place a light by clicking the subject | Beat 5.1 on the hero figure                                                                                                         |
| Changing the world loses nothing              | Beat 6.2 replays the same pose with no cut between the swap and the replay                                                          |
| The AI's edits and yours share one undo       | Beat 7.2 is one take                                                                                                                |
| The same film under different looks           | Beats 8.1 and 8.2 share a frame that can be overlaid. **Not yet true** (#1601)                                                      |
| "Procedural" (closing tag only)               | The scene is one graph of decisions, shown in 9.1. No beat in this cut shows a procedural parameter; that is the second cut (#1597) |

Claims the video does **not** make: world's first, easiest, fastest, real-time AI render, better than any named tool, a scene made from one sentence.

---

## 18. Risks

| Risk                                                           | Likelihood | Effect                                                                         | Answer                                                                                                                                                          |
| -------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A viewer reads the opening as "Basher made this from a prompt" | Medium     | Trust, once someone tries it                                                   | The cold open's prompt stays on the competitor's screen; level 1 shows opening a project; no caption or post says a sentence made it                            |
| There is no scene-wide slow motion                             | High       | No centrepiece                                                                 | Build it second; fall back to a hard freeze                                                                                                                     |
| Generated run and fire motions look floaty                     | Measured   | The chase is not intense: runs top at 5.1 m/s, arms tucked, no recoil (#1600)  | Trim the wind-up, speed the clip about 1.5×, cut tighter and lower, key the recoil by hand (#1399 only if the fire is generated)                                |
| The hero figures look like test assets                         | High       | The ending falls flat                                                          | Figures chosen 2026-10-16 (runner: cyberpunk character; pursuer: a mecha)                                                                                       |
| A gunshot at a person limits where the video can run           | Medium     | Paid placement refused on some platforms; a harder tone for a general audience | Keep a second version with a stylised projectile (a dart, an arrow, a thrown blade). The structure is identical.                                                |
| Insider vocabulary visible in panels                           | High       | A director feels it is a 3D package                                            | Measured 2026-10-13: the outliner shows `n_box`, the inspector shows spare params and data types (#1625, #1627). Fix those two before shooting; collapse panels |
| The AI look flickers across twelve seconds                     | Medium     | The final film looks cheap                                                     | Pick looks for stability; fast cuts hide more than a slow shot does                                                                                             |
| A competitor ships the same beat before launch                 | Medium     | A "nobody else" beat becomes ordinary                                          | Claim nothing by comparison in the video itself                                                                                                                 |
| A viewer calls it faked                                        | Low        | Trust                                                                          | Publish raw takes and the project                                                                                                                               |
| The video promises depth the product cannot hold in real use   | Medium     | Churn after sign-up                                                            | Every beat must be repeatable by a new user on the demo project                                                                                                 |

---

## 19. Open decisions

1. Is the tag "a procedural 3D film studio in your browser"?
2. Is "world's first" off the screen?
3. A bullet, or a stylised projectile? Or both versions?
4. ~~Who are the two figures, and who makes or licenses them?~~ Decided 2026-10-16: the runner is the cyberpunk character (CC-BY-4.0, credited); the pursuer is a rigged mecha the user supplies.
5. Which two AI looks?
6. Captions only, or a voice as well?
7. Does the graph appear at all for a general audience, or only on the landing page?
8. What is the launch date, and what is allowed to slip: the date or a level?
9. Which set does the finished film (10.1) play in? 7.2 as written ends in the plaza, while the film's logline and the sparks on the wall assume the alley. Either the film moves to the plaza, or 7.2 ends on the alley without the sparks.

---

## 20. The work, in order

1. ~~Try the one-sentence scene in the app as it stands.~~ Done (#1593): measured, then moved to the second cut.
2. Decide how the whole scene slows, and build it.
3. Try an AI look on a posed, lit frame.
4. Generate a run and a draw-and-fire; judge them honestly.
5. ~~Choose the two figures.~~ Done 2026-10-16.
6. Build the shots panel and timeline cuts.
7. ~~Build the alley from one length value.~~ Second cut (#1597). This cut: swap the alley for the plaza.
8. Settle the conditional issues in §12.2.
9. Build the demo project with a checkpoint per level.
10. Run every remaining beat once on the demo project; fix or cut.
11. Build sparks, the look control and the graph view.
12. Commission the music.
13. Rehearse to the count, shoot one take per beat.
14. Edit the full cut, then the cut-downs.
15. Build the landing page to match, and release.

Steps 1 to 4 decide whether the script above survives. Everything after them is production.

**Where they stand (2026-10-16):** step 1 measured and moved to the second cut (#1593), and step 7 likewise (#1597). Step 2 (#1594) is built on a local branch, not yet merged. As of 2026-10-14: Step 2 is #1594, not started. Step 3 run outside Basher only: the pose holds, the frame and the light do not; the in-app run waits on a ComfyUI server. Step 4 done: usable with a trim, a speed-up and a hand-keyed recoil. Step 5 under way in the alley-run tests: a generated character rigged outside Basher, run along a path after fixes #1632–#1635.
