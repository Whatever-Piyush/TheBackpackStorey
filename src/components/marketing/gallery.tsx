import { GALLERY } from "@/lib/site";
import { ElevationTag } from "@/components/elevation-tag";
import { GalleryLightbox } from "@/components/lightbox";
import { Reveal } from "@/components/motion/reveal";

/**
 * Gallery — an editorial masonry of the property's own photos. Composition and
 * the block reveal live in GalleryLightbox (which also owns the lightbox modal);
 * this section is a plain wrapper, so the modal's fixed positioning is never
 * trapped inside a transformed ancestor.
 */
export function Gallery() {
  return (
    <section className="border-t hairline bg-forest/40 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <Reveal>
          <ElevationTag label="The place" />
          <h2 className="mt-4 font-display text-3xl font-extrabold tracking-tight text-paper sm:text-4xl">
            Have a look around
          </h2>
          <p className="mt-3 text-sm text-sage/80">Tap any photo to open the gallery.</p>
        </Reveal>
        <div className="mt-10">
          <GalleryLightbox photos={GALLERY} />
        </div>
      </div>
    </section>
  );
}
