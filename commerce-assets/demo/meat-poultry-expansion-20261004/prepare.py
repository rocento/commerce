import json
from pathlib import Path
root=Path(__file__).resolve().parent
image_overrides=json.loads((root/'image-overrides.json').read_text()) if (root/'image-overrides.json').exists() else {}
# Demo merchandise, deliberately distinct from existing steaks, breasts, drumsticks, chops and ground beef.
rows=[
 ('chicken-thighs','Boneless Chicken Thighs 500g','أفخاذ دجاج مخلية ٥٠٠ جم','500g',0.5,'4.75','Raw boneless, skinless chicken thigh fillets for grilling, roasting or quick stir-fries.','أفخاذ دجاج نيئة مخلية من العظام ومنزوعة الجلد، مناسبة للشواء أو الطهي في الفرن أو القلي مع التقليب.',['grilling','roasting','sauteing'],['stir_fries','rice_dishes','roast_dinners']),
 ('chicken-wings','Chicken Wings 1kg','أجنحة دجاج ١ كجم','1kg',1,'5.25','Raw whole chicken wings with skin and bones, ready for roasting or grilling with your choice of seasoning.','أجنحة دجاج كاملة نيئة بالجلد والعظام، مناسبة للطهي في الفرن أو الشواء مع التتبيلة التي تختارها.',['roasting','grilling'],['roast_dinners']),
 ('whole-chicken','Whole Chicken 2kg','دجاجة كاملة ٢ كجم','2kg',2,'10.50','A whole raw chicken with skin and bones for family roast dinners, chicken soup or rice dishes.','دجاجة كاملة نيئة بالجلد والعظام، مناسبة لوجبات الدجاج المشوي العائلية أو شوربة الدجاج أو أطباق الأرز.',['roasting','boiling'],['roast_dinners','soups','rice_dishes']),
 ('turkey-breast','Turkey Breast Fillets 500g','فيليه صدر ديك رومي ٥٠٠ جم','500g',0.5,'6.75','Raw boneless, skinless turkey breast fillets for grilling, pan cooking or slicing into stir-fries.','فيليه صدر ديك رومي نيئ مخلي من العظام ومنزوع الجلد، مناسب للشواء أو الطهي في المقلاة أو التقطيع لأطباق القلي مع التقليب.',['grilling','sauteing','roasting'],['stir_fries','rice_dishes','sandwiches']),
 ('turkey-mince','Turkey Mince 500g','لحم ديك رومي مفروم ٥٠٠ جم','500g',0.5,'5.75','Plain raw minced turkey for homemade meatballs, pasta sauces or rice dishes. Unseasoned so you can add your own ingredients.','لحم ديك رومي نيئ مفروم وغير متبل، مناسب لتحضير كرات اللحم المنزلية أو صلصات المكرونة أو أطباق الأرز، مع إضافة المكونات التي تفضلها.',['sauteing','baking'],['pasta_dishes','rice_dishes']),
 ('chicken-tenderloins','Chicken Tenderloins 500g','فيليه دجاج تندرلوين ٥٠٠ جم','500g',0.5,'9.75','Raw boneless, skinless chicken tenderloins for grilling, pan cooking and stir-fries.','قطع تندرلوين دجاج نيئة، مخلية من العظام ومنزوعة الجلد، مناسبة للشواء أو الطهي في المقلاة وأطباق القلي مع التقليب.',['grilling','sauteing'],['stir_fries','rice_dishes']),
 ('beef-stew-cubes','Beef Stew Cubes 1kg','مكعبات لحم بقري للطهي ١ كجم','1kg',1,'11.50','Raw boneless beef cut into cubes for slow-cooked casseroles, soups and rice dishes. Unseasoned and ready for your recipe.','لحم بقري نيئ مخلي من العظام ومقطع إلى مكعبات، مناسب للطواجن بطيئة الطهي والشوربات وأطباق الأرز، وغير متبل لتجهيزه حسب وصفتك.',['boiling','roasting'],['soups','rice_dishes','roast_dinners']),
 ('beef-short-ribs','Beef Short Ribs 1kg','أضلاع بقري قصيرة ١ كجم','1kg',1,'13.50','Raw bone-in beef short ribs with thick meat, suited to slow roasting and rich family meals.','أضلاع بقري قصيرة نيئة بالعظام مع طبقة سميكة من اللحم، مناسبة للطهي البطيء في الفرن والوجبات العائلية الغنية.',['roasting'],['roast_dinners','rice_dishes']),
 ('lamb-shanks','Lamb Shanks 1kg','موزات ضأن ١ كجم','1kg',1,'14.50','Raw bone-in lamb shanks for slow roasting or simmering until tender, served with rice or vegetables.','موزات ضأن نيئة بالعظام، مناسبة للطهي البطيء في الفرن أو على نار هادئة حتى تنضج وتقديمها مع الأرز أو الخضروات.',['roasting','boiling'],['roast_dinners','rice_dishes']),
 ('lamb-mince','Lamb Mince 500g','لحم ضأن مفروم ٥٠٠ جم','500g',0.5,'7.25','Plain raw minced lamb for homemade kofta, meatballs and stuffed vegetables. Unseasoned for flexible everyday cooking.','لحم ضأن نيئ مفروم وغير متبل، مناسب لتحضير الكفتة وكرات اللحم والخضروات المحشوة في المنزل حسب التتبيلة التي تفضلها.',['grilling','sauteing','baking'],['rice_dishes','pasta_dishes'])
]
products=[]; translations=[];prompts=[]
subjects=[
 'four raw boneless skinless chicken thigh fillets, pale pink, neatly trimmed',
 'a neat group of raw whole chicken wings with skin, recognizable wing joints',
 'one whole raw plucked prepared roasting chicken, skin on, legs and wings tucked, no head or feet',
 'two raw boneless skinless turkey breast fillets, large pale pink cuts',
 'a neat mound of raw minced turkey, pale pink ground meat',
 'raw boneless skinless chicken tenderloins in a simple cream ceramic tray lined with white butcher paper',
 'a neat pile of raw boneless beef stew cubes, roughly three centimeter chunks',
 'three raw beef short rib pieces, thick red meat with visible cross-cut rib bones',
 'two raw lamb shanks, clearly recognizable small lower-leg bone-in cuts with trimmed meat',
 'a neat mound of raw minced lamb, red pink ground meat with fine white fat'
]
for i,(key,name,ar,size,weight,price,desc,ardesc,prep,dish) in enumerate(rows,1):
 sku=f'GRO-MEAT-20261004-{i:03d}'
 arsize={'500g':'٥٠٠ جم','1kg':'١ كجم','2kg':'٢ كجم'}[size]
 short=f'{desc} Pack size: {size}.'
 arshort=f'{ardesc} حجم العبوة: {arsize}.'
 attrs={'grocery-pack-size':size,'weight':weight,'grocery_group':['meat'],'ingredient_role':['main_ingredient'],'meal_occasion':['lunch','dinner'],'preparation_method':prep,'dish_type':dish,'short_description':short,'meta_title':f'{name} | Rocento Grocery','meta_description':f'{name}. {desc} Shop at Rocento Grocery.'}
 products.append(dict(sku=sku,slug='grocery-'+key+'-'+size,name=name,price=price,currency='USD',unit='pack',category='grocery-meat-poultry',image=key+'.png',initial_quantity=1000,description=short+' Keep refrigerated and cook thoroughly before serving. Illustrative demo product photography.',attributes=attrs))
 translations.append({'sku':sku,'fields':{'name':ar,'description':arshort+' يُحفظ مبردًا ويُطهى جيدًا قبل التقديم. صورة توضيحية لمنتج في الكتالوج التجريبي.','attribute.short_description':arshort,'attribute.meta_title':f'{ar} | Rocento للبقالة','attribute.meta_description':f'{ar}. {ardesc} تسوّق من Rocento للبقالة.'}})
 prompts.append({'image':key+'.png','tool':'built-in image_gen','prompt':f'Use case: product-mockup. Asset type: square ecommerce grocery product photograph for a demo catalog. Subject: {subjects[i-1]}. Photorealistic studio food photography on seamless pure white background, clean butcher-prepared grocery meat, centered and fully visible with generous white margins, soft natural shadow, high detail, slightly elevated three-quarter view. Product only, no garnish, no herbs, no plates, no board, no packaging, no text, no logos, no borders, no graphic gore. Single square photo, not a collage.'})
for key,override in image_overrides.items():
 for product in products:
  if product['image']==key+'.png': product['image']=override['image']
 for prompt in prompts:
  if prompt['image']==key+'.png': prompt.update(override)
for name,data in [('manifest.json',{'products':products}),('translations-ar.json',translations),('image-prompts.json',prompts)]:
 (root/name).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
before=json.loads((root/'before.json').read_text());defs={d['attribute_code']:d for d in before['definitions']}
for p in products:
 assert p['name'] not in before['all_names']
 for code,value in p['attributes'].items():
  if defs[code]['options']:assert set(value if isinstance(value,list) else [value])<={o['value'] for o in defs[code]['options']},(code,value)
print('Prepared 10 distinct products, valid attribute options, 50 Arabic translation fields.')
