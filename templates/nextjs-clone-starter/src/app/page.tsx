// PIXEL-CLONE: replace with the cloned sections, in the page order recorded in CLONE_NOTES.md.
// Helpers available: <Reveal/> (Framer Motion), useScrollTrigger() (GSAP), <CloneCanvas/> (R3F).
//
// Dump-and-replay sections (SKILL.md "Scroll-driven experiences and bespoke renderers"), composed like this:
//   import { ReplayPreload, loadReplayHero } from "@/replay/ReplayPreload";
//   import { ReplayHeroProvider, DomLayer } from "@/replay/DomLayer";
//   import { ReplaySpacer } from "@/replay/ReplaySpacer";
//   import { ThreeReplay } from "@/replay/ThreeReplay";
//   export default function Home() {
//     return (
//       <ReplayHeroProvider hero={loadReplayHero()}>   {/* hero UI server-rendered, anchored by CSS */}
//         <ReplayPreload />                               {/* hero data requested before hydration */}
//         <ReplaySpacer />                                {/* the target's scroll length per viewport */}
//         <ThreeReplay />
//         <HeroSection /> <StorySection /> ...            {/* each: <DomLayer sections={["<section>"]} /> */}
//       </ReplayHeroProvider>
//     );
//   }
export default function Home() {
  return <main />;
}
