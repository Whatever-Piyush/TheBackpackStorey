/**
 * Single source of truth for the public site.
 *
 * Facts here are real: phones / address / check-in-out come from the build spec,
 * amenities + policies from the live listing, photos are the property's own.
 * We deliberately do NOT invent room prices — live rates stay on the booking page
 * until Phase 4 brings bookings in-house.
 */

export const SITE = {
  name: "Backpackers Storey",
  tagline: "A hostel under the launch",
  description:
    "A small backpacker hostel and rooftop café in Bir, Himachal Pradesh — under the world's second-highest paragliding launch. A female dorm, a male dorm, four private rooms, bonfire nights and a valley view.",
  // Launch domain on Netlify (apex is primary; www redirects here). Drives
  // metadataBase, the sitemap and robots.
  url: "https://thebackpackerstory.in",
  // Phase 1 fallback: bookings stay on zotel until Phase 4.
  bookingUrl: "https://www.zotel.ai/hotels/backpackers-storey-bir",

  location: {
    area: "Bir",
    region: "Himachal Pradesh",
    country: "India",
    postalCode: "176077",
    line: "Bir, Himachal Pradesh 176077, India",
  },

  // The pin of the property's Google Maps listing, "The backpack storey" (from
  // the owner's link, 2026-11-19). Drives the map, "Get directions" and the
  // coordinates shown across the site; the flight/altitude device draws on it too.
  coords: { lat: 32.0432252, lng: 76.7457533 },
  elevation: {
    property: 1450, // metres, Bir village
    launch: 2400, // metres, Billing — the paragliding launch above Bir
  },

  checkIn: "2:00 PM",
  checkOut: "11:00 AM",

  phones: ["+91 98166 10852", "+91 78272 22036"],
  whatsapp: "+91 98166 10852",
} as const;

/* ---------------------------------------------------------------- whatsapp */

/** The enquiry every WhatsApp CTA opens with, unless a more specific one is given. */
export const WHATSAPP_ENQUIRY = "Hi Backpackers Storey! I'd like to ask about a booking.";

/** wa.me deep link to the property's WhatsApp number with a prefilled message. */
export function whatsappEnquiryLink(message: string = WHATSAPP_ENQUIRY): string {
  const digits = SITE.whatsapp.replace(/[^\d]/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

export const NAV: { label: string; href: string }[] = [
  { label: "Stay", href: "/rooms" },
  { label: "Café", href: "/#cafe" },
  { label: "Bir", href: "/#bir" },
  { label: "Visit", href: "/#visit" },
];

/* ------------------------------------------------------------------ photos */

export type Photo = { src: string; alt: string };

// Categorised from the property's own photos (downloaded into /public/photos).
export const PHOTOS = {
  heroCafe: { src: "/photos/hero-cafe.jpg", alt: "The rooftop café at night, glowing with warm Edison bulbs and blue fairy lights over brick walls, murals and bistro tables" },
  exterior: { src: "/photos/photo-01.jpg", alt: "The colourful exterior of Backpackers Storey with prayer flags and a turf courtyard" },
  cafeInterior: { src: "/photos/photo-02.jpg", alt: "Cosy café corner with fairy lights, board games and a forest-facing window" },
  mural: { src: "/photos/photo-03.jpg", alt: "An astronaut mural beside a 'Travel is my therapy' signpost" },
  lounge: { src: "/photos/photo-06.jpg", alt: "A lounge corner with framed art and cushioned seating against a deep purple wall" },
  food: { src: "/photos/photo-07.jpg", alt: "Burgers, fries and a drink on a wooden table by the café window" },
  sign: { src: "/photos/photo-09.jpg", alt: "The hand-painted Backpackers Storey sign on the rooftop wall" },
  rooftopDay: { src: "/photos/photo-10.jpg", alt: "The open rooftop café by day, looking out over the hills" },
  rooftopDusk: { src: "/photos/photo-11.jpg", alt: "The rooftop café at dusk, string lights glowing over a valley view" },
} satisfies Record<string, Photo>;

/* ------------------------------------------------------------------- rooms */

/**
 * Room-type codes the booking engine and PMS sell (`room_types.code` in the
 * database). The public site shows the named rooms below instead; these codes
 * stay untouched so the paused /book flow keeps working. Before booking is
 * switched back on, the inventory needs remodelling for two dorms and four
 * private rooms (the database still models one mixed dorm and three private types).
 */
export type RoomType = "dorm" | "deluxe" | "premium" | "family";

/** What the paused /book flow offers, one entry per room type (mirrors migrations 0003/0004). */
export const BOOKABLE_ROOM_TYPES: { code: RoomType; name: string; isDorm: boolean; sleeps: number }[] = [
  { code: "dorm", name: "Six-Bed Dormitory", isDorm: true, sleeps: 6 },
  { code: "deluxe", name: "Deluxe Room", isDorm: false, sleeps: 2 },
  { code: "premium", name: "Premium Room", isDorm: false, sleeps: 3 },
  { code: "family", name: "Family Room", isDorm: false, sleeps: 4 },
];

/**
 * The property's real rooms, named as on its booking-channel listing, with the
 * owner's own photos (October 2026). Copy and features describe only what those
 * photos show: no capacities, prices or facilities beyond them.
 */
export type Room = {
  slug: string; // URL segment: /rooms/<slug>
  name: string;
  label: string; // badge text and WhatsApp context: "Female dorm", "Room 1" …
  kind: string; // short qualifier shown under the name
  isDorm: boolean;
  short: string; // card blurb
  long: string[]; // detail-page paragraphs
  features: string[]; // only what the room's own photos show
  photos: Photo[]; // first is the cover; empty shows a "photos coming soon" panel
  bookingType?: RoomType; // booking-engine type, where one is known
};

/** /photos/rooms/<slug>/NN.jpg, numbered in display order (01 is the cover). */
function roomPhotos(slug: string, alts: string[]): Photo[] {
  return alts.map((alt, i) => ({
    src: `/photos/rooms/${slug}/${String(i + 1).padStart(2, "0")}.jpg`,
    alt,
  }));
}

// The owner filed this one photo under both Room 1 and Room 2.
const WELCOME_KIT: Photo = {
  src: "/photos/rooms/welcome-kit.jpg",
  alt: "A washbasin with a fresh towel and a welcome toiletry kit",
};

export const ROOMS: Room[] = [
  {
    slug: "wildflower-den",
    name: "The Wildflower Den",
    label: "Female dorm",
    kind: "Shared dorm · Bunk beds",
    isDorm: true,
    short:
      "The female dorm: metal bunks, cobalt-blue walls and a painted backpacker mural.",
    long: [
      "The Wildflower Den is our dorm for women: metal bunk beds in a cobalt-blue room under a wooden ceiling, with a mural of a backpacker, camera in hand, painted across one wall.",
      "The dorm's bathroom is painted the same blue, with a shower, a washbasin and a geyser for hot water.",
    ],
    features: ["Metal bunk beds", "Hand-painted mural", "Hot-water geyser", "Female dorm"],
    photos: roomPhotos("wildflower-den", [
      "A metal bunk bed beside a window with yellow curtains in The Wildflower Den",
      "Metal bunk beds, a blue chair and posters on the blue walls of The Wildflower Den",
      "A mural of a backpacker with a camera, painted between the bunks",
      "The blue bathroom with a shower, a washbasin and a hot-water geyser",
      "A western toilet in the blue bathroom",
    ]),
    bookingType: "dorm",
  },
  {
    slug: "trailblazers-den",
    name: "The Trailblazer's Den",
    label: "Male dorm",
    kind: "Shared dorm",
    isDorm: true,
    short: "The male dorm at Backpackers Storey. Ask us on WhatsApp about beds, availability and rates.",
    long: [
      "The Trailblazer's Den is our dorm for men.",
      "We're still adding its photos. Message us on WhatsApp to ask about beds, availability and rates.",
    ],
    features: [],
    photos: [],
    bookingType: "dorm",
  },
  {
    slug: "valley-window",
    name: "The Valley Window",
    label: "Room 1",
    kind: "Private room · Double bed",
    isDorm: false,
    short:
      "A bright private room with a window full of green hills and the valley just outside.",
    long: [
      "Room 1 is all about the view. Cream curtains frame a window onto forested hills, and the door opens to a white railing with the valley spread out beyond it.",
      "Inside there's a double bed with a pine headboard, a low wooden table on a patterned rug with poufs around it, and a tall yellow stool by the window.",
    ],
    features: ["Hill-view window", "Valley outlook", "Low table & poufs", "Double bed"],
    photos: [
      ...roomPhotos("valley-window", [
        "Cream curtains, a window onto green hills, a low wooden table and a yellow stool in The Valley Window",
        "The double bed with a pine headboard and navy covers, a low table on a patterned rug in front",
        "The Valley Window from the doorway, with the double bed, a low table, poufs and a floor lamp",
        "The door open to a white railing and forested hills, beside a curtained window",
        "A low table, a yellow stool and a carved mirror by the curtained window",
        "Forested hills and fields under a cloudy sky beyond the white railing",
        "Green hills framed by the open wooden door",
        "Mist drifting over the hills beyond the railing",
        "A washbasin with a mirror and a towel ring",
      ]),
      WELCOME_KIT,
    ],
  },
  {
    slug: "natures-edge",
    name: "Nature's Edge",
    label: "Room 2",
    kind: "Private room · Double bed",
    isDorm: false,
    short: "A private double with a carved standing mirror, a mandala rug and a door out to the hills.",
    long: [
      "Room 2 sits at the edge of the green. Open the door and the hillside is right there beyond the railing.",
      "Inside there's a double bed with a pine headboard, a low wooden table on a red-and-blue mandala rug, an electric kettle by the bed and a tall carved mirror draped with a leafy vine.",
    ],
    features: ["Door out to the hills", "Electric kettle", "Carved standing mirror", "Double bed"],
    photos: [
      ...roomPhotos("natures-edge", [
        "The double bed with a pine headboard and navy covers in Nature's Edge, a mandala rug and low table in front",
        "The door open to a railing and the green hillside, beside a low table and a curtained window",
        "Two curtained windows above a low wooden table and a mandala rug",
        "A tall carved mirror draped with a leafy vine, next to the door out to the hills",
        "The double bed, side tables and an electric kettle in Nature's Edge",
        "A side table with an electric kettle and plants beside the bed",
      ]),
      WELCOME_KIT,
    ],
  },
  {
    slug: "mountain-nook",
    name: "The Mountain Nook",
    label: "Room 3",
    kind: "Private room · Double bed",
    isDorm: false,
    short: "A calm private room whose window is filled, edge to edge, by a forested mountain.",
    long: [
      "Room 3 looks straight at the mountain: a green-curtained window with a wooden table and a vase of red flowers in front of it, and a door that opens to the railing.",
      "There's a double bed with a pine headboard, a floor lamp, an electric kettle and three bright paintings set into a wall niche. The bathroom has a rain shower, a geyser for hot water and black-and-white patterned tiles.",
    ],
    features: ["Mountain-view window", "Rain shower & geyser", "Electric kettle", "Double bed"],
    photos: roomPhotos("mountain-nook", [
      "A forested mountain fills the window beyond the bed and a table of flowers in The Mountain Nook",
      "The forested mountainside framed by the window, with red flowers in a glass vase",
      "The door open to a railing, a green-curtained window and paintings in a wall niche",
      "The double bed with a pine headboard and navy covers behind a low wooden table",
      "The bed, a floor lamp and a side table with a kettle along one wall",
      "A wooden table with red flowers and a blue metal chair beneath the window",
      "Three colourful paintings in a wall niche above a blue chair",
      "A floor lamp, drinking water and an electric kettle beside the bed",
      "The bathroom with a rain shower, a washbasin and patterned floor tiles",
      "A rain shower, a washbasin and a towel ring in the bathroom",
      "Bathroom taps, a soap dispenser and black-and-white floor tiles",
      "A western toilet beneath a hot-water geyser",
      "A western toilet, a geyser and a soap dispenser in the bathroom",
      "The hot-water geyser above the toilet cistern",
    ]),
  },
  {
    slug: "forest-haven",
    name: "The Forest Haven",
    label: "Room 4",
    kind: "Private room · Double bed",
    isDorm: false,
    short: "A long, sunlit private room with a big window into the trees and a door out to the hills.",
    long: [
      "Room 4 runs long: the double bed at one end, a big low table in the middle and, at the far end, a wide window into the trees beside a door that opens to the hills.",
      "A small high window lets in extra light, and a framed painting hangs above the pine headboard.",
    ],
    features: ["Window into the trees", "Door out to the hills", "Ceiling fan", "Double bed"],
    photos: roomPhotos("forest-haven", [
      "The double bed with a pine headboard beneath a framed painting in The Forest Haven",
      "A wide window looking into green trees and the hillside",
      "The long room: the bed in front, a low table, then a window and an open door at the far end",
      "The Forest Haven from the doorway, with the double bed, a floor lamp and a long wooden table",
      "The door open to a railing and the hills, beside a curtained window",
      "A low table with flowers in front of the window and the open door",
      "The bed, a low table and a small high window letting in extra light",
      "The bed with navy cushions under framed art, and a wooden table with red flowers",
      "A round wooden stool beside a low table under a small high window",
    ]),
  },
];

export function getRoom(slug: string): Room | undefined {
  return ROOMS.find((r) => r.slug === slug);
}

/** A room's photo by its display number; fails the build if it doesn't exist. */
function roomPhoto(slug: string, n: number): Photo {
  const photo = getRoom(slug)?.photos[n - 1];
  if (!photo) throw new Error(`No photo ${n} for room "${slug}"`);
  return photo;
}

/* ----------------------------------------------------------------- gallery */

export const GALLERY: Photo[] = [
  PHOTOS.rooftopDusk,
  PHOTOS.exterior,
  PHOTOS.rooftopDay,
  PHOTOS.cafeInterior,
  PHOTOS.food,
  roomPhoto("wildflower-den", 3),
  roomPhoto("valley-window", 1),
  PHOTOS.mural,
  PHOTOS.lounge,
  PHOTOS.sign,
  roomPhoto("forest-haven", 1),
  roomPhoto("mountain-nook", 1),
];

/* --------------------------------------------------------------- amenities */
// `icon` names map to lucide-react exports (verified present).

export const AMENITIES: { label: string; icon: string }[] = [
  { label: "Rooftop café", icon: "Coffee" },
  { label: "Free WiFi", icon: "Wifi" },
  { label: "Bonfire nights", icon: "Flame" },
  { label: "Valley & hill views", icon: "Mountain" },
  { label: "Attached bath in select rooms", icon: "ShowerHead" },
  { label: "Gaming zone", icon: "Gamepad2" },
  { label: "Mini gym", icon: "Dumbbell" },
  { label: "Camp stay", icon: "Tent" },
  { label: "On-site parking", icon: "Car" },
  { label: "Heating", icon: "Thermometer" },
  { label: "Pet-friendly", icon: "PawPrint" },
  { label: "Pine forest air", icon: "Trees" },
];

/* ----------------------------------------------------------------- café */

export const CAFE = {
  name: "The Rooftop Café",
  blurb:
    "Multi-cuisine plates, real coffee and mocktails, served on an open rooftop strung with lights and pointed at the valley. Outside food is welcome; so are the dogs.",
  highlights: ["Multi-cuisine", "Mocktails", "Burgers & fries", "Coffee", "Board games", "Valley-view seating"],
  photos: [
    PHOTOS.heroCafe,
    PHOTOS.rooftopDusk,
    PHOTOS.rooftopDay,
    PHOTOS.cafeInterior,
    PHOTOS.food,
    PHOTOS.mural,
    PHOTOS.lounge,
    PHOTOS.sign,
  ],
} as const;

/* ------------------------------------------------------------- experiences */

export const EXPERIENCES: { title: string; icon: string; body: string }[] = [
  {
    title: "Paragliding at Billing",
    icon: "Wind",
    body: "The world's second-highest paragliding launch sits a short drive up the hill. Tandem flights land in Bir, minutes from the door.",
  },
  {
    title: "Monasteries & tea",
    icon: "Sparkles",
    body: "Bir is a Tibetan settlement — colourful monasteries, prayer flags and tea gardens are all within an easy wander or a short ride.",
  },
  {
    title: "Bonfire & gaming nights",
    icon: "Flame",
    body: "Evenings turn social: a bonfire with music, a gaming zone indoors and a meditation corner for when the day's been big enough.",
  },
];

/* --------------------------------------------------------------- location */

// The property's Google Maps listing, "The backpack storey" (from the owner's
// link, minus its fixed starting point and tracking codes).
const GOOGLE_LISTING = {
  name: "The+backpack+storey",
  featureId: "0x3904bf3bd897d49f:0x3794dfa45eac4d6f",
  knowledgeGraphId: "%2Fg%2F11mt68j8v8",
};

export const MAPS = {
  embed: `https://www.google.com/maps?q=${SITE.coords.lat},${SITE.coords.lng}&z=14&output=embed`,
  // "Get directions" opens the full listing: photos, reviews, address, prices and
  // Google's own Directions button, which routes from the visitor's location.
  directions: `https://www.google.com/maps/place/${GOOGLE_LISTING.name}/@${SITE.coords.lat},${SITE.coords.lng},15z/data=!4m6!3m5!1s${GOOGLE_LISTING.featureId}!8m2!3d${SITE.coords.lat}!4d${SITE.coords.lng}!16s${GOOGLE_LISTING.knowledgeGraphId}`,
} as const;

export const GETTING_HERE =
  "Nearest airport: Gaggal / Kangra (~1 hr). Volvo buses run Delhi → Baijnath, then a 20-min taxi to Bir. Tell us your arrival and we'll help with the last mile.";

/* ------------------------------------------------------ nearby attractions */

export type Attraction = {
  slug: string;
  name: string;
  distance: string;
  blurb: string;
  icon: string; // lucide name (see components/icon usage / direct import)
  photo: string; // /photos/nearby/<slug>.jpg (optional — falls back to a gradient)
  maps: string;
};

export const ATTRACTIONS: Attraction[] = [
  {
    slug: "gunehar-waterfall",
    name: "Gunehar Waterfall",
    distance: "1.5 km",
    blurb:
      "A scenic waterfall hidden in the forest, reached by a short trek — a refreshing nature escape.",
    icon: "Waves",
    photo: "/photos/nearby/gunehar-waterfall.jpg",
    maps: "https://www.google.com/maps/search/?api=1&query=Gunehar+Waterfall+Bir",
  },
  {
    slug: "bir-landing",
    name: "Bir Landing Site",
    // Google Maps, from the property: 5.2 km on foot, 5.2-7.3 km by road (~22-24 min).
    distance: "5 km",
    blurb:
      "The famous paragliding landing field, ringed by mountains — open skies and breathtaking sunset views.",
    icon: "Mountain",
    photo: "/photos/nearby/bir-landing.jpg",
    // Pinned to Google's "Landing Site Bir" listing; a text search landed on a road.
    maps: "https://www.google.com/maps/place/Landing+Site+Bir/@32.042493,76.708247,17z/data=!4m6!3m5!1s0x3904b90061debb77:0x10edb647890c66c4!8m2!3d32.042493!4d76.708247!16s%2Fg%2F11z2vsrvc2",
  },
  {
    slug: "billing-takeoff",
    name: "Bir Billing Paragliding",
    // Google Maps, from the property: 13.3 km up the Bir-Billing road (~36 min).
    distance: "13 km",
    blurb:
      "The world-famous takeoff at Billing — tandem flights and schools soaring over scenic valleys.",
    icon: "Wind",
    photo: "/photos/nearby/billing-takeoff.jpg",
    // Pinned to Google's "Bir Billing Takeoff" listing; a text search listed operators.
    maps: "https://www.google.com/maps/place/Bir+Billing+Takeoff/@32.0596905,76.744456,17z/data=!4m6!3m5!1s0x3904bf28912e2dff:0xd9dcc11b5c916d95!8m2!3d32.0596905!4d76.744456!16s%2Fg%2F12jmjzfg9",
  },
  {
    slug: "bungee",
    name: "Bungee Jumping",
    distance: "2 km",
    blurb:
      "A 50-metre leap with full safety gear and a video to take home — pure adrenaline near the landing site.",
    icon: "ArrowDownToLine",
    photo: "/photos/nearby/bungee.jpg",
    maps: "https://www.google.com/maps/search/?api=1&query=Bungee+Jumping+Bir+Billing",
  },
  {
    slug: "skycycling",
    name: "Sky Cycling",
    distance: "2 km",
    blurb:
      "Pedal a cycle 500 metres along a cable strung high across the valley — thrilling and surreal.",
    icon: "Bike",
    photo: "/photos/nearby/skycycling.jpg",
    maps: "https://www.google.com/maps/search/?api=1&query=Sky+Cycling+Bir+Billing",
  },
  {
    slug: "chokling-monastery",
    name: "Chokling Monastery",
    // Google Maps, from the property: 5.1 km on foot, 4.9-5.8 km by road (~20 min).
    distance: "5 km",
    blurb:
      "A Tibetan Buddhist monastery in Bir Colony, its grand stupa crowned by a golden spire — calm and peaceful.",
    icon: "ShipWheel", // lucide's ship wheel doubles as the dharma wheel
    photo: "/photos/nearby/chokling-monastery.jpg",
    // Pinned to the monastery's own Google Maps listing rather than a text search,
    // so Directions always opens this exact place.
    maps: "https://www.google.com/maps/place/Chokling+Monastery/@32.0367413,76.7118999,17z/data=!4m6!3m5!1s0x3904b9514553cc4b:0x8ab4f212ee42e14e!8m2!3d32.0367413!4d76.7118999!16s%2Fg%2F11sk9l2nml",
  },
];
