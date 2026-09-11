---
name: MEU Exchange
description: Photographic city landscapes, cream editorial space, and violet connections.
colors:
  paper: "#f7f6f2"
  purple: "#7165ed"
  ink: "#252527"
  line: "#d7d5d1"
  section-label: "#6a60d2"
  selected-tab: "#6557df"
  text-link: "#5140c5"
  text-link-hover: "#25167a"
  navigation-active: "#a79cff"
  navigation: "rgba(29,29,30,.94)"
  white: "#fff"
  demo-surface: "#faf9f6"
  current-step: "#6551d3"
  button-hover: "#6353d2"
  light-button-hover: "#ded8ff"
typography:
  display:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "clamp(42px,4.5vw,86px)"
    fontWeight: 300
    lineHeight: 1.06
    letterSpacing: "-.04em"
  headline:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "clamp(38px,4.6vw,68px)"
    fontWeight: 350
    lineHeight: 1.07
    letterSpacing: "-.04em"
  title:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "clamp(28px,3vw,44px)"
    fontWeight: 350
    lineHeight: 1.12
    letterSpacing: "-.04em"
  body:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "14px"
    lineHeight: 1.6
  label:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    letterSpacing: ".12em"
rounded:
  control: "3px"
  navigation: "4px"
spacing:
  gutter: "clamp(24px,5vw,88px)"
  frame-margin: "40px"
  mobile-frame-margin: "16px"
  mobile-frame-padding: "20px"
components:
  button-dark:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.white}"
    rounded: "{rounded.control}"
    padding: "14px 20px"
  button-dark-hover:
    backgroundColor: "{colors.button-hover}"
  button-light:
    backgroundColor: "{colors.paper}"
    textColor: "#29282c"
    rounded: "{rounded.control}"
    padding: "14px 20px"
  button-light-hover:
    backgroundColor: "{colors.light-button-hover}"
  navigation:
    backgroundColor: "{colors.navigation}"
    textColor: "{colors.white}"
    rounded: "{rounded.navigation}"
    padding: "23px 27px"
  application-tab-selected:
    textColor: "{colors.selected-tab}"
    padding: "20px 25px"
  demo-workspace:
    backgroundColor: "{colors.demo-surface}"
---

# Design System: MEU Exchange

## Overview

The user-selected Geolava reference establishes the visual direction: photographic aerial city views, generous cream editorial sections, light DM Sans headlines, and violet accents. Pixel edges, fine measurement lines, and diamond anchors connect the photographic and typographic parts of the page.

The previous CSS-generated terrain and Manrope treatment have been replaced. Visual implementation lives in `src/styles/landing.css`, structure in `src/pages/index.astro`, and interactions in `src/scripts/landing.ts`.

## Colors

Purple carries large editorial statements, geometric details, and focus outlines. Smaller text uses the darker section-label, selected-tab, and text-link tokens. Navigation uses a lighter violet over its dark translucent surface. Preserve these distinct roles when extending the page.

Paper and ink define reading sections. Fine neutral borders organize frames, facts, and workflow rows. White headings sit over dark photographic fields; the demo workspace has a slightly lighter cream surface.

## Typography

DM Sans is served locally as a variable font with a sans-serif fallback and swap loading. Light, tightly tracked display type gives the page its scale; headings use balanced wrapping. Body copy is typically 14–15px on desktop with 1.6 line height, and 13px in mobile content sections. Section labels use uppercase text and loose tracking.

The hero is a low, centered statement with a mobile-only line break. The introductory violet statement uses a lighter weight and wider line height than ordinary section headings. The oversized footer statement repeats the display character.

## Layout

Full-width photographic sections alternate with spacious editorial frames. Desktop frames have dashed side borders, 40px outside margins, and the fluid gutter token. Heading/copy pairs and image/content pairs align in two columns, with generous vertical spacing between sections.

At 1000px, frames use 24px margins and 36px inner padding. At 700px, they use the mobile frame tokens, section headings and paired content stack, and navigation becomes a full-width compact bar with an expandable menu. The hero is 100svh with a 640px minimum on desktop, and 94svh with a 670px minimum on mobile. Lifecycle pins are repositioned vertically for narrow screens.

## Elevation & Depth

Photography and aligned image layers provide most of the depth. Reading sections use borders and tonal separation. Floating navigation adds a restrained shadow and backdrop blur; image annotations use translucent dark panels and blur. Editorial content remains flat.

## Shapes

Buttons and navigation have small corner radii; content frames, tab panels, and the demo workspace are rectangular. Diamonds recur in the wordmark, section markers, image brackets, annotation anchors, and connection diagram. Square image cells and stepped pixel edges extend that geometry at photographic scale.

## Components

- Navigation is centered, fixed, dark, and translucent. Active section links turn light violet. The mobile menu reports expansion, closes on link selection, and closes on Escape with focus returned to its button.
- Dark and cream actions pair compact labels with thin arrows. Text links use the darker violet. Keyboard focus has a 2px purple outline with a 6px offset.
- The photographic scanner reveals spatially aligned mesh, X-ray, and derived false-colour patches over the city photograph. Pointer, touch, and arrow keys move the grid; the reveal fades. A shared pause control and reduced-motion preference disable scanning. The diagram's animated connector also stops for reduced motion.
- Lifecycle annotations expand one at a time; the expanded panel becomes violet. Their layout changes at narrow widths.
- Application tabs use a bottom rule and visible arrow for selection. Arrow keys, Home, and End change tabs and expose the associated image-and-text panel.
- The demonstration workspace pairs an illustrative instrument with four numbered rows. Current, completed, and upcoming states include text labels. Advance and reset controls update the local demonstration; the description announces changes politely. Mobile stacks the summary above the rows.
- A native details/summary disclosure reveals the integration overview.

## Do's and Don'ts

- Do preserve alignment between the base photograph and all scanner layers.
- Do carry the cream, violet, fine-line, and diamond vocabulary through related sections.
- Do retain visible keyboard focus, textual workflow states, and reduced-motion behavior.
- Don't replace the requested photographic landscape with CSS-generated terrain.
- Don't present the scanner's false-colour imagery as measured or live asset data. Asset provenance and reuse constraints are recorded in `ASSETS.md`.
