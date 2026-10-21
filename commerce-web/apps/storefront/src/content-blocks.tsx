import { PublicationImage } from './public/image';
import { type ContentBlock } from "@commerce/api-client";
export function ContentBlocks({ blocks }: { blocks: ContentBlock[] }) {
  return (
    <>
      {blocks.map((b, n) => (
        <section className={`content-block content-${b.kind}`} key={n}>
          <div>
            {b.heading && <h2>{b.heading}</h2>}
            {b.text && <p>{b.text}</p>}
            {b.link_url && (
              <a
                className={b.kind === "hero" ? "primary-link" : "text-button"}
                href={b.link_url}
              >
                {b.link_label}
              </a>
            )}
          </div>
          {b.image_id && (
            <PublicationImage primary id={b.image_id} alt={b.heading || ""} />
          )}
        </section>
      ))}
    </>
  );
}
