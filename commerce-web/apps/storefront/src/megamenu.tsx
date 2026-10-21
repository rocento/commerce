import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { type ContentBlock } from '@commerce/api-client';
import { localizedMenuUrl, type MenuLocale } from './menu-locale';
import './megamenu.css';
export { safeNavigationUrl as safeMenuUrl } from '@commerce/api-client';
import { safeNavigationUrl as safeMenuUrl } from '@commerce/api-client';
function MenuLink({url,locale,newTab,children,onClick}:{url:string;locale:MenuLocale;newTab?:boolean;children:ReactNode;onClick?:()=>void}) {
  if (!safeMenuUrl(url)) return <span>{children}</span>;
  return url.startsWith('/') ? <Link to={localizedMenuUrl(url,locale)} target={newTab?'_blank':undefined} rel={newTab?'noopener noreferrer':undefined} onClick={onClick}>{children}</Link> : <a href={url} target={newTab?'_blank':undefined} rel={newTab?'noopener noreferrer':undefined} onClick={onClick}>{children}</a>;
}
export function Megamenu({blocks,locale='en'}:{blocks:ContentBlock[];locale?:MenuLocale}) {
  const [open,setOpen]=useState<number|null>(null);
  const location=useLocation(); const root=useRef<HTMLElement>(null); const triggers=useRef<(HTMLButtonElement|null)[]>([]);
  useEffect(()=>setOpen(null),[location.key,locale]);
  useEffect(()=>{
    const close=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(null);};
    document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);
  },[]);
  const items=blocks.filter(b=>b.navigation?.enabled);
  return <nav ref={root} className="category-nav managed-megamenu" lang={locale} dir={locale==='ar'?'rtl':'ltr'} aria-label={locale==='ar'?'التنقل في المتجر':'Shop navigation'} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))setOpen(null);}} onKeyDown={e=>{if(e.key==='Escape' && open!==null){e.preventDefault();triggers.current[open]?.focus();setOpen(null);}}}>
    <div className="megamenu-row">{items.map((b,i)=>{
      const n=b.navigation!;
      const label=<><span aria-hidden="true">{n.icon}</span>{b.link_label}{n.badge && <small className="megamenu-badge">{n.badge}</small>}</>;
      return <div className="megamenu-item" key={i}>{n.links.length ? <button type="button" ref={el=>{triggers.current[i]=el;}} aria-expanded={open===i} aria-controls={`megamenu-panel-${i}`} onClick={()=>setOpen(open===i?null:i)}>{label}<span aria-hidden="true">⌄</span></button> : <MenuLink locale={locale} url={b.link_url} newTab={n.new_tab}>{label}</MenuLink>}
      </div>;
    })}</div>
    {items.map((b,i)=>{
      const n=b.navigation!;
      const groups=Array.from(new Set(n.links.map(l=>l.group)));
      return n.links.length>0 && <div key={i} id={`megamenu-panel-${i}`} className="megamenu-panel" hidden={open!==i}>
          <div className="megamenu-heading"><strong>{b.link_label}</strong><MenuLink locale={locale} url={b.link_url} newTab={n.new_tab} onClick={()=>setOpen(null)}>{locale==='ar'?'استكشف الكل ←':'Explore all →'}</MenuLink></div>
          <div className="megamenu-columns" style={{gridTemplateColumns:`repeat(${n.columns},minmax(0,1fr))`}}>{groups.map(group=><section key={group}>{group && <h3>{group}</h3>}<ul>{n.links.filter(l=>l.group===group).map((l,j)=><li key={j}><MenuLink locale={locale} url={l.url} newTab={l.new_tab} onClick={()=>setOpen(null)}><span aria-hidden="true">{l.icon}</span><span>{l.label}{l.description && <small>{l.description}</small>}</span></MenuLink></li>)}</ul></section>)}</div>
        </div>;
    })}
  </nav>;
}
