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
    "A small backpacker hostel and rooftop café in Bir, Himachal Pradesh — under the world's second-highest paragliding launch. A six-bed dorm, a handful of private rooms, bonfire nights and a valley view.",
  // Update to the real domain at launch.
  url: "https://backpackersstorey.com",
  // Phase 1 fallback: bookings stay on zotel until Phase 4.
  bookingUrl: "https://www.zotel.ai/hotels/backpackers-storey-bir",

  location: {
    area: "Bir",
    region: "Himachal Pradesh",
    country: "India",
    postalCode: "176077",
    line: "Bir, Himachal Pradesh 176077, India",
  },

  // The flight/altitude signature device draws on these.
  coords: { lat: 32.0419, lng: 76.7197 },
  elevation: {
    property: 1450, // metres, Bir village
    launch: 2400, // metres, Billing — the paragliding launch above Bir
  },

  checkIn: "2:00 PM",
  checkOut: "11:00 AM",

  phones: ["+91 98166 10852", "+91 78272 22036"],
  whatsapp: "+91 98166 10852",
} as const;

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
  roomA: { src: "/photos/photo-04.jpg", alt: "A private room with a double bed, patterned walls and a woven rug" },
  roomB: { src: "/photos/photo-05.jpg", alt: "A private room with a wooden-framed double bed and an ornate red rug" },
  lounge: { src: "/photos/photo-06.jpg", alt: "A lounge corner with framed art and cushioned seating against a deep purple wall" },
  food: { src: "/photos/photo-07.jpg", alt: "Burgers, fries and a drink on a wooden table by the café window" },
  bathroom: { src: "/photos/photo-08.jpg", alt: "An attached bathroom with a geyser and western fittings" },
  sign: { src: "/photos/photo-09.jpg", alt: "The hand-painted Backpackers Storey sign on the rooftop wall" },
  rooftopDay: { src: "/photos/photo-10.jpg", alt: "The open rooftop café by day, looking out over the hills" },
  rooftopDusk: { src: "/photos/photo-11.jpg", alt: "The rooftop café at dusk, string lights glowing over a valley view" },
  dormA: { src: "/photos/photo-12.jpg", alt: "The dormitory with low beds and mandala tapestries" },
  dormB: { src: "/photos/photo-13.jpg", alt: "The dorm at night, lit by an ambient galaxy projector" },
} satisfies Record<string, Photo>;

export const GALLERY: Photo[] = [
  PHOTOS.rooftopDusk,
  PHOTOS.exterior,
  PHOTOS.rooftopDay,
  PHOTOS.cafeInterior,
  PHOTOS.food,
  PHOTOS.dormA,
  PHOTOS.roomA,
  PHOTOS.mural,
  PHOTOS.lounge,
  PHOTOS.sign,
  PHOTOS.roomB,
  PHOTOS.dormB,
];

/* ------------------------------------------------------------------- rooms */

export type RoomType = "dorm" | "deluxe" | "premium" | "family";

export type Room = {
  slug: RoomType;
  name: string;
  kind: string; // short qualifier shown under the name
  sleeps: number;
  isDorm: boolean;
  short: string; // card blurb
  long: string[]; // detail-page paragraphs
  features: string[]; // grounded in the live amenity list
  photos: Photo[];
};

export const ROOMS: Room[] = [
  {
    slug: "dorm",
    name: "Six-Bed Dormitory",
    kind: "Shared · per bed",
    sleeps: 6,
    isDorm: true,
    short:
      "Six beds, mandala tapestries and fairy lights — the cheapest way to wake up under the launch.",
    long: [
      "The dorm is the heart of a backpacker stop: six beds in one warm, low-lit room hung with mandala tapestries, with a galaxy projector for the late talkers.",
      "It is the social bed — you will meet the people you fly, hike and sit at the bonfire with. Bring a headlamp and a sense of humour.",
    ],
    features: ["Six beds", "Shared bathroom", "Heating", "Free WiFi", "Fresh forest air", "Steps from the rooftop café"],
    photos: [PHOTOS.dormA, PHOTOS.dormB, PHOTOS.sign],
  },
  {
    slug: "deluxe",
    name: "Deluxe Room",
    kind: "Private · sleeps 2",
    sleeps: 2,
    isDorm: false,
    short: "A private double with an attached bathroom and an open balcony to the hills.",
    long: [
      "A private double for two, with an attached bathroom, an open balcony and a LED smart TV for the slow mornings after a long flight.",
      "Quiet, warm and a short climb from the café — the room most guests pick when they want the hostel energy without the shared room.",
    ],
    features: ["Double bed", "Attached bathroom", "Open balcony", "Hill view", "LED smart TV", "Heating", "Free WiFi"],
    photos: [PHOTOS.roomA, PHOTOS.bathroom],
  },
  {
    slug: "premium",
    name: "Premium Room",
    kind: "Private · sleeps 2–3",
    sleeps: 3,
    isDorm: false,
    short: "Our roomiest private — a living corner, a landmark view and space to spread out.",
    long: [
      "The premium room trades nothing for comfort: a private double with room for an extra mattress, a small living corner and a landmark view across the valley.",
      "Best for couples who want to stay a while, or a friend who insists on their own space between flights.",
    ],
    features: ["Double bed", "Extra mattress on request", "Attached bathroom", "Living area", "Landmark view", "Heating", "Free WiFi"],
    photos: [PHOTOS.roomB, PHOTOS.bathroom],
  },
  {
    slug: "family",
    name: "Family Room",
    kind: "Private · sleeps 4",
    sleeps: 4,
    isDorm: false,
    short: "Room for four, a private bathroom and a fully fenced property the kids can roam.",
    long: [
      "The family room sleeps four in private, with an attached bathroom and a living area — and a fully fenced property with a turf courtyard so younger guests have somewhere safe to roam.",
      "Pets are welcome, the host speaks Hindi and English, and the café downstairs keeps everyone fed.",
    ],
    features: ["Sleeps four", "Attached bathroom", "Living area", "Fenced property", "Family-friendly", "Pet-friendly", "Heating"],
    photos: [PHOTOS.roomA, PHOTOS.roomB],
  },
];

export function getRoom(slug: string): Room | undefined {
  return ROOMS.find((r) => r.slug === slug);
}

/* --------------------------------------------------------------- amenities */
// `icon` names map to lucide-react exports (verified present).

export const AMENITIES: { label: string; icon: string }[] = [
  { label: "Rooftop café", icon: "Coffee" },
  { label: "Free WiFi", icon: "Wifi" },
  { label: "Bonfire nights", icon: "Flame" },
  { label: "Valley & hill views", icon: "Mountain" },
  { label: "Attached bathrooms", icon: "ShowerHead" },
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
  photos: [PHOTOS.rooftopDusk, PHOTOS.rooftopDay, PHOTOS.food, PHOTOS.cafeInterior],
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
