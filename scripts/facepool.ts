// bun scripts/facepool.ts — regenerates src/facepool-data.ts from the Fontsource
// catalogue (https://api.fontsource.org/v1/fonts). The lists below are curated by
// hand: Latin-friendly Google Fonts, roughly a hundred per role, every one OFL /
// Apache / UFL (Google Fonts has no CC0 faces worth the name). Faces that also
// ship bundled with the app are marked `local` so the roll can land on them
// without a download.
import { writeFileSync } from 'node:fs';

const CURATED: Record<string, string[]> = {
  franklin: `inter hanken-grotesk atkinson-hyperlegible nunito work-sans libre-franklin
    roboto open-sans lato montserrat poppins raleway source-sans-3 pt-sans ubuntu fira-sans dm-sans manrope rubik karla
    cabin mulish oswald barlow barlow-condensed archivo archivo-narrow josefin-sans jost outfit plus-jakarta-sans space-grotesk
    syne lexend figtree sora urbanist be-vietnam-pro public-sans red-hat-display red-hat-text ibm-plex-sans overpass questrial
    quicksand varela-round exo-2 titillium-web kanit prompt heebo assistant hind catamaran chivo epilogue bricolage-grotesque
    familjen-grotesk schibsted-grotesk instrument-sans geist onest golos-text albert-sans gantari commissioner alegreya-sans
    merriweather-sans nunito-sans encode-sans signika asap saira teko khand fjalla-one yanone-kaffeesatz pathway-gothic-one
    league-gothic league-spartan oxygen dosis maven-pro arimo cantarell didact-gothic abel advent-pro antonio chakra-petch
    orbitron michroma unbounded wix-madefor-text reddit-sans host-grotesk mona-sans funnel-sans parkinsans ysabeau spline-sans
    inclusive-sans andika sarabun tomorrow jura play roboto-condensed inter-tight darker-grotesque tenor-sans julius-sans-one
    belleza philosopher rosario proza-libre six-caps national-park special-gothic recursive`,
  serif: `fraunces lora libre-baskerville crimson-pro eb-garamond
    merriweather playfair-display pt-serif source-serif-4 libre-caslon-text libre-caslon-display cormorant-garamond cormorant
    spectral literata newsreader alegreya crimson-text cardo gentium-plus gentium-book-plus old-standard-tt libre-bodoni
    bodoni-moda dm-serif-display dm-serif-text playfair instrument-serif young-serif ibm-plex-serif roboto-serif roboto-slab
    zilla-slab bitter arvo rokkitt josefin-slab crete-round domine vollkorn neuton gelasio faustina manuale petrona piazzolla
    brygada-1918 bona-nova ibarra-real-nova sorts-mill-goudy goudy-bookletter-1911 linden-hill prata rufina rozha-one
    yeseva-one cinzel marcellus della-respira tinos caladea noticia-text pridi taviraj alice andada-pro antic-slab baskervville
    besley hepta-slab castoro eczar fanwood-text gloock hedvig-letters-serif imbue judson kreon lusitana lustria mate ovo
    quando quattrocento radley sedan slabo-27px solway texturina vidaloka volkhov wittgenstein yrsa balthazar belgrano
    bellefair brawler cambo copse coustard cutive enriqueta esteban fenix gabriela gilda-display glegoo headland-one
    inknut-antiqua kameron ledger libertinus-serif oranienbaum podkova poly prociono sanchez scope-one stoke suez-one
    trocchi unna vesper-libre im-fell-english im-fell-dw-pica grenze bree-serif aleo kalnia montagu-slab bevan graduate
    patua-one holtwood-one-sc`,
  mono: `ibm-plex-mono jetbrains-mono fira-mono space-mono courier-prime
    anonymous-pro azeret-mono b612-mono chivo-mono cousine cutive-mono datatype dm-mono fira-code fragment-mono geist-mono
    google-sans-code hibur-mono inconsolata intel-one-mono iosevka-charon iosevka-charon-mono kode-mono lekton
    libertinus-mono lilex m-plus-1-code major-mono-display martian-mono monofett nova-mono overpass-mono oxygen-mono pt-mono
    red-hat-mono reddit-mono roboto-mono share-tech-mono sixtyfour sometype-mono source-code-pro spline-sans-mono syne-mono
    ubuntu-mono ubuntu-sans-mono victor-mono vt323 workbench xanh-mono atkinson-hyperlegible-mono cascadia-code suse-mono`,
  comic: `kalam patrick-hand comic-neue architects-daughter gloria-hallelujah
    caveat caveat-brush indie-flower shadows-into-light shadows-into-light-two permanent-marker amatic-sc dancing-script
    pacifico satisfy courgette kaushan-script handlee homemade-apple reenie-beanie rock-salt just-another-hand
    covered-by-your-grace coming-soon schoolbell short-stack neucha itim mali sriracha gochi-hand delius delius-swash-caps
    delius-unicase walter-turncoat sue-ellen-francisco waiting-for-the-sunrise the-girl-next-door nothing-you-could-do
    over-the-rainbow la-belle-aurore dawning-of-a-new-day cedarville-cursive zeyada kristi loved-by-the-king give-you-glory
    crafty-girls annie-use-your-telescope swanky-and-moo-moo sunshiney just-me-again-down-here mansalva fuzzy-bubbles
    grape-nuts borel playpen-sans shantell-sans sedgwick-ave rancho redressed marck-script merienda pangolin sacramento
    yellowtail great-vibes allura alex-brush parisienne tangerine cookie grand-hotel damion norican niconne leckerli-one
    berkshire-swash bad-script caramel chilanka condiment comforter-brush cherish fondamento italianno julee kolker-brush
    league-script licorice lugrasimo lumanosimo ms-madi my-soul mynerve nanum-pen-script nerko-one oooh-baby praise
    qwitcher-grypen ruthie sassy-frass splash square-peg twinkle-star vibur water-brush whisper windsong yomogi gaegu
    delicious-handrawn edu-au-vic-wa-nt-hand playwrite-us-trad playwrite-de-grund calligraffitti charm clicker-script
    engagement kings meddon pinyon-script rochester rouge-script style-script beth-ellen are-you-serious`,
  shout: `bangers anton bebas-neue luckiest-guy alfa-slab-one
    abril-fatface righteous lobster lobster-two bungee bungee-shade bungee-inline bungee-outline passion-one titan-one
    lilita-one black-ops-one boogaloo bowlby-one bowlby-one-sc carter-one chewy concert-one creepster fredoka fugaz-one
    gravitas-one knewave limelight monoton poller-one press-start-2p racing-sans-one rammetto-one rowdies rubik-mono-one
    russo-one shrikhand sigmar-one sigmar special-elite squada-one staatliches ultra unica-one vast-shadow wallpoet
    bagel-fat-one bakbak-one bubblegum-sans calistoga caprasimo changa-one chango cherry-bomb-one chicle coiny contrail-one
    dela-gothic-one dynapuff erica-one faster-one fascinate fontdiner-swanky freckle-face frijole gluten goblin-one
    grandstander honk jolly-lodger kablammo kavoon lemon londrina-solid londrina-shadow londrina-outline mclaren modak nabla
    new-rocker nosifer oi oleo-script original-surfer paytone-one pirata-one plaster poetsen-one protest-riot protest-strike
    protest-revolution protest-guerrilla rubik-bubbles rubik-glitch rubik-spray-paint rubik-wet-paint rubik-dirt
    rubik-beastly rye sancreek sansita silkscreen slackey smokum sniglet spicy-rice tilt-warp tilt-prism tilt-neon tourney
    train-one trade-winds zen-dots big-shoulders bigshot-one bungee-spice cabin-sketch climate-crisis comic-relief
    fredericka-the-great germania-one keania-one lacquer lily-script-one mystery-quest pixelify-sans ranchers ribeye
    road-rage salsa seaweed-script sonsie-one spirax stardos-stencil stalinist-one ewert fruktur jacquard-12 jersey-10
    micro-5 bitcount atomic-age audiowide bahiana barrio baumans butcherman caesar-dressing ceviche-one cherry-cream-soda
    cinzel-decorative codystar corben eater emblema-one metal-mania metamorphous monoton mountains-of-christmas nova-square
    piedra playball rubik-80s-fade sarina skranji uncial-antiqua unkempt vampiro-one vina-sans warnes archivo-black`,
};
/** fontsource id → bundled face id (text.ts FACES) */
const LOCAL: Record<string, string> = {
  'hanken-grotesk': 'hanken', inter: 'inter', 'atkinson-hyperlegible': 'atkinson', nunito: 'nunito', 'work-sans': 'worksans', 'libre-franklin': 'librefranklin',
  fraunces: 'fraunces', lora: 'lora', 'libre-baskerville': 'baskerville', 'crimson-pro': 'crimson', 'eb-garamond': 'garamond',
  'ibm-plex-mono': 'plexmono', 'jetbrains-mono': 'jetbrains', 'fira-mono': 'firamono', 'space-mono': 'spacemono', 'courier-prime': 'courierprime',
  kalam: 'kalam', 'patrick-hand': 'patrick', 'comic-neue': 'comicneue', 'architects-daughter': 'architects', 'gloria-hallelujah': 'gloria',
  bangers: 'bangers', anton: 'anton', 'bebas-neue': 'bebas', 'luckiest-guy': 'luckiest', 'alfa-slab-one': 'alfaslab',
};
const GENERIC: Record<string, string> = { franklin: 'sans-serif', serif: 'serif', mono: 'monospace', comic: 'cursive', shout: 'sans-serif' };

interface Meta { id: string; family: string; subsets: string[]; weights: number[]; styles: string[]; variable: boolean; category: string; license: string }
const src = process.argv[2];
const list: Meta[] = src ? JSON.parse(await Bun.file(src).text()) : await (await fetch('https://api.fontsource.org/v1/fonts')).json();
const byId = new Map(list.map((m) => [m.id, m]));

let out = `// GENERATED by scripts/facepool.ts from the Fontsource catalogue — do not edit by hand.
// Extra typefaces the dice can roll, per role. Loaded on demand from jsDelivr's
// Fontsource CDN; \`local\` marks faces that are also bundled (see text.ts FACES).
export interface PoolFace {
  id: string; // fontsource id (CDN path)
  name: string; // CSS family name
  css: string; // family + generic fallback
  wght?: [number, number]; // variable weight axis
  bold?: number; // heaviest static weight to fetch besides 400 (700 where available)
  italic?: boolean;
  local?: string; // bundled face id
  lic: string;
}
export const POOL: Record<string, PoolFace[]> = {
`;
let total = 0;
for (const [role, raw] of Object.entries(CURATED)) {
  const ids = [...new Set(raw.split(/\s+/).filter(Boolean))];
  const faces: string[] = [];
  for (const id of ids) {
    const m = byId.get(id);
    if (!m) { console.error(`${role}: unknown id ${id}`); continue; }
    if (!m.subsets.includes('latin') || !m.weights.includes(400)) { console.error(`${role}: ${id} lacks latin/400`); continue; }
    const f: Record<string, unknown> = { id, name: m.family, css: `"${m.family}",${GENERIC[role]}` };
    if (m.variable) f.wght = [Math.min(...m.weights), Math.max(...m.weights)];
    else {
      const heavy = m.weights.includes(700) ? 700 : Math.max(...m.weights);
      if (heavy > 400) f.bold = heavy;
    }
    if (m.styles.includes('italic')) f.italic = true;
    if (LOCAL[id]) f.local = LOCAL[id];
    f.lic = m.license;
    faces.push(`    ${JSON.stringify(f).replace(/"(\w+)":/g, '$1: ').replace(/,/g, ', ')},`);
  }
  total += faces.length;
  console.log(`${role}: ${faces.length}`);
  out += `  ${role}: [\n${faces.join('\n')}\n  ],\n`;
}
out += '};\n';
writeFileSync(new URL('../src/facepool-data.ts', import.meta.url), out);
console.log(`total ${total} → src/facepool-data.ts`);
