// Convert published demo sections to editable, tenant-owned App Studio drafts.
// Only the supported, explicit demo section types are accepted.
const assert = require('node:assert/strict');
const groceryOrder=['grocery-fruit','grocery-vegetables','grocery-dairy-eggs','grocery-bakery','grocery-pantry','grocery-meat-poultry','grocery-fish-seafood','grocery-dates-nuts'];
function demoLayout(store, current, theme, assets, categories, availability={}) {
 const config=structuredClone(current),home=theme.configuration.pages.home.filter(s=>s.enabled),messages=config.localization.messages;
 config.configVersion=0;config.compatibility={minIosRuntime:'1.2.0',minAndroidRuntime:'1.2.0'};
 config.screens.home.layout='storefront';
 const radius=theme.configuration.tokens['radius.default'];config.brand.radiusToken=radius===0?'none':radius<=8?'small':radius<=18?'medium':'large';config.brand.density='comfortable';
 const scoped=categories.filter(c=>groceryOrder.includes(c.slug));
 const ordered=[...(scoped.length?scoped:categories)].sort((a,b)=>(availability[b.id]||0)-(availability[a.id]||0)||((groceryOrder.indexOf(a.slug)<0?999:groceryOrder.indexOf(a.slug))-(groceryOrder.indexOf(b.slug)<0?999:groceryOrder.indexOf(b.slug))));
 const manifest=[];
 config.screens.home.sections=home.map(source=>{
  const id=`demo_${store}_${source.id}`,p=source.settings;
  function text(field,fallback){const key=`${id}_${field}`,value=p[field]||fallback;assert(value,`Missing ${store}/${source.id}/${field}`);for(const locale of config.localization.supportedLocales){messages[locale]||={};messages[locale][key]=source.translations?.[locale]?.[field]?.value||value;}return key;}
  function copy(){return {headingKey:text('heading'),...(p.text?{bodyKey:text('text')}:{}),...(p.eyebrow?{eyebrowKey:text('eyebrow')}:{}),...(p.label?{labelKey:text('label')}:{}),appearance:'editorial'};}
  function action(){const target=p.href?.match(/^\/categories\/([a-zA-Z0-9_-]+)$/)?.[1],category=target&&categories.find(c=>c.id===target||c.slug===target);return category?{type:'openCategory',categoryId:category.id}:{type:'openTab',tab:p.href==='/register'||p.href==='/account'?'account':'categories'};}
  let result;
  switch(source.component){
   case 'hero':case 'editorial_hero':case 'image_text': {
    const asset=assets.find(a=>a.name===`${store} demo banner ${source.id}`&&a.verified);assert(asset,`Missing ${store} banner ${source.id}`);
    result={id,type:'heroBanner',props:{imageAssetId:asset.id,accessibilityLabelKey:text('alt',p.heading),...copy(),action:action()}};break;
   }
   case 'banner':case 'rich_text': {
    const hasBody=Boolean(p.text);
    const props={textKey:text(hasBody?'text':'heading'),appearance:source.component==='banner'?'campaign':'editorial'};
    if(hasBody)props.headingKey=text('heading');
    if(p.label){props.labelKey=text('label');if(['/assistant','/register'].includes(p.href))props.storefrontPath=p.href;else props.action=action();}
    result={id,type:'richText',props};break;
   }
   case 'category_grid':case 'category_showcase':
    result={id,type:'categoryGrid',props:{titleKey:text('heading'),categoryIds:ordered.slice(0,Math.min(12,p.limit||8)).map(c=>c.id),appearance:'tiles'}};break;
   case 'featured_products':case 'product_collection':case 'recommendations':case 'best_sellers':
    result={id,type:'productGrid',props:{collectionId:`demo-feed-${source.id}`,titleKey:text('heading'),columns:2,limit:Math.max(1,Math.min(24,p.limit||8))}};break;
   default:throw Error(`Unsupported demo section ${source.component}`);
  }
  manifest.push({sourceId:source.id,sourceType:source.component,id,type:result.type,heading:p.heading,feed:result.props.collectionId});return result;
 });
 assert(config.screens.home.sections.length<=30);
 return {config,manifest};
}
module.exports={demoLayout};
