import { Hero } from "@/components/marketing/hero";
import { Intro } from "@/components/marketing/intro";
import { RoomsShowcase } from "@/components/marketing/rooms-showcase";
import { Cafe } from "@/components/marketing/cafe";
import { AroundBir } from "@/components/marketing/around-bir";
import { Amenities } from "@/components/marketing/amenities";
import { Gallery } from "@/components/marketing/gallery";
import { FinalCta } from "@/components/marketing/final-cta";

export default function HomePage() {
  return (
    <>
      <Hero />
      <Intro />
      <RoomsShowcase />
      <Cafe />
      <AroundBir />
      <Amenities />
      <Gallery />
      <FinalCta />
    </>
  );
}
