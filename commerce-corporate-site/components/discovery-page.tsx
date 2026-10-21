import { SiteIcon } from "@/components/site-icon";
import Link from "next/link";
import type { DiscoveryPage as Page } from "@/lib/discovery";
import { demos, site } from "@/lib/site";

export function BreadcrumbJsonLd({items}:{items:{name:string;path:string}[]}) {
  const data={"@context":"https://schema.org","@type":"BreadcrumbList",itemListElement:items.map((x,i)=>({"@type":"ListItem",position:i+1,name:x.name,item:`${site.url.replace(/\/$/,"")}${x.path}`}))};
  return <script type="application/ld+json" dangerouslySetInnerHTML={{__html:JSON.stringify(data).replace(/</g,"\\u003c")}}/>;
}
export function DiscoveryDetail({page,section}:{page:Page;section:"features"|"industries"|"docs"}) {
  const demo = section === "industries" ? demos.find(item => item.id === page.slug) : undefined;
  return <>
    <BreadcrumbJsonLd items={[{name:"Home",path:"/"},{name:section[0].toUpperCase()+section.slice(1),path:`/${section}/`},{name:page.title,path:`/${section}/${page.slug}/`}]}/>
    <header className="page-hero container discovery-hero"><p className="eyebrow"><span>01</span>{page.eyebrow}</p><h1>{page.title}</h1><p>{page.summary}</p><span className="status-label">{page.status}</span></header>
    <div className="container page-content discovery-detail">
      <section><p className="eyebrow"><span>02</span>WHAT IT SUPPORTS</p><h2>Practical outcomes</h2><ul>{page.outcomes.map(x=><li key={x}>{x}</li>)}</ul></section>
      <section><p className="eyebrow"><span>03</span>HOW IT WORKS</p><h2>Platform capabilities</h2>{page.facts.map(x=><p key={x}>{x}</p>)}</section>
      <aside><p className="eyebrow"><span>04</span>PLANNING YOUR IMPLEMENTATION</p><h2>What to plan for</h2>{page.limits.map(x=><p key={x}>{x}</p>)}</aside>
      {demo?.url && <a className="button primary" href={demo.url}>Explore {demo.title} demo <SiteIcon /></a>}
      <Link className="button secondary" href={`/${section}/`}><SiteIcon name="left" /> All {section}</Link>
    </div>
  </>;
}
export function DiscoveryIndex({title,summary,items,section}:{title:string;summary:string;items:Page[];section:"features"|"industries"|"docs"}) {
  return <><BreadcrumbJsonLd items={[{name:"Home",path:"/"},{name:title,path:`/${section}/`}]}/><header className="page-hero container"><p className="eyebrow"><span>01</span>ROCENTO {section.toUpperCase()}</p><h1>{title}</h1><p>{summary}</p></header><section className="container page-content discovery-grid">{items.map(x=><Link className="discovery-card" key={x.slug} href={`/${section}/${x.slug}/`}><span className="status-label">{x.status}</span><h2>{x.title}</h2><p>{x.summary}</p><span className="text-link">Explore details <SiteIcon /></span></Link>)}</section></>;
}
