import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { ContentBlock } from '@commerce/api-client';
import { Megamenu, safeMenuUrl } from './megamenu';
const item:ContentBlock={kind:'link',heading:'',text:'',image_id:null,link_label:'Shop',link_url:'/search',navigation:{icon:'🛍',badge:'New',enabled:true,new_tab:false,columns:3,links:[{label:'Fruit',url:'/categories/fruit',group:'Fresh',icon:'🍎',description:'Seasonal produce',new_tab:false}]}};
it.each(['javascript:alert(1)','//example.com','/\\example.com','https://example.com\n','https://','data:text/html,test'])('rejects unsafe URL %s',url=>expect(safeMenuUrl(url)).toBe(false));
it.each(['/search','/categories/fruit','https://example.com/page'])('allows navigation URL %s',url=>expect(safeMenuUrl(url)).toBe(true));
it('renders accessible collapsed dropdowns and omits disabled items',()=>{
 const html=renderToStaticMarkup(<MemoryRouter><Megamenu blocks={[item,{...item,link_label:'Hidden',navigation:{...item.navigation!,enabled:false}}]}/></MemoryRouter>);
 expect(html).toContain('aria-expanded="false"');expect(html).toContain('aria-controls="megamenu-panel-0"');expect(html).toContain('hidden=""');expect(html).toContain('Fresh');expect(html).toContain('Seasonal produce');expect(html).not.toContain('Hidden');
});
it('protects external new-tab links and does not render unsafe anchors',()=>{
 const html=renderToStaticMarkup(<MemoryRouter><Megamenu blocks={[{...item,link_url:'https://example.com',navigation:{...item.navigation!,links:[],new_tab:true}},{...item,link_url:'javascript:alert(1)',navigation:{...item.navigation!,links:[]}}]}/></MemoryRouter>);
 expect(html).toContain('rel="noopener noreferrer"');expect(html).toContain('target="_blank"');expect(html).not.toContain('javascript:');
});
it('renders Arabic navigation with RTL layout and localized internal destinations',()=>{
 const arabic={...item,link_label:'تسوق',navigation:{...item.navigation!,badge:'جديد',links:[{...item.navigation!.links[0],label:'فواكه',group:'طازج',description:'فواكه موسمية'}]}};
 const html=renderToStaticMarkup(<MemoryRouter><Megamenu blocks={[arabic]} locale="ar"/></MemoryRouter>);
 expect(html).toContain('dir="rtl"');expect(html).toContain('lang="ar"');
 expect(html).toContain('التنقل في المتجر');expect(html).toContain('استكشف الكل ←');
 expect(html).toContain('فواكه موسمية');expect(html).toContain('/categories/fruit?lang=ar');
 expect(html).not.toContain('<select');expect(html).not.toContain('Explore all');
});
it('renders English menu controls and preserves language on internal links',()=>{
 const html=renderToStaticMarkup(<MemoryRouter><Megamenu blocks={[item]} locale="en"/></MemoryRouter>);
 expect(html).toContain('dir="ltr"');expect(html).not.toContain('<select');
 expect(html).toContain('Explore all');expect(html).toContain('/categories/fruit?lang=en');
});
it('preserves the shared language without rendering a second selector',()=>{
 const html=renderToStaticMarkup(<MemoryRouter><Megamenu blocks={[item]} locale="fr"/></MemoryRouter>);
 expect(html).not.toContain('<select');
 expect(html).toContain('/categories/fruit?lang=fr');
});
