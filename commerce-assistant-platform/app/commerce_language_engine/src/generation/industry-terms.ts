import type {Alias} from '../types.ts';
// Authored generic vocabulary: no invented inventory, SKU, availability or medical claims.
// Pipe separates canonical concept from interchangeable surface forms.
const categories:Record<string,string>= {
GROCERY:`apple|apple|apples
banana|banana|bananas
orange|orange fruit|oranges
strawberry|strawberry|strawberries
blueberry|blueberry|blueberries
mango|mango|mangoes|mangos
avocado|avocado|avocados
tomato|tomato|tomatoes
potato|potato|potatoes
onion|onion|onions
carrot|carrot|carrots
cucumber|cucumber|cucumbers
broccoli|broccoli
spinach|spinach
lettuce|lettuce
eggs|eggs|chicken eggs
yogurt|yogurt|yoghurt
butter|butter
cheese|cheese
chicken_breast|chicken breast|chicken breasts
lentils|lentils
chickpeas|chickpeas|garbanzo beans
oats|oats|rolled oats
flour|flour
honey|honey
peanut_butter|peanut butter
sparkling_water|sparkling water|carbonated water`,
FASHION:`hoodie|hoodie|hoodies
sweatshirt|sweatshirt|sweatshirts
trousers|trousers|pants
shorts|shorts
skirt|skirt|skirts
blazer|blazer|blazers
coat|coat|coats
cardigan|cardigan|cardigans
leggings|leggings
pajamas|pajamas|pyjamas
sandals|sandals
boots|boots
slippers|slippers
loafers|loafers
scarf|scarf|scarves
belt|belt|belts
handbag|handbag|handbags
backpack|backpack|backpacks
sunglasses|sunglasses
swimwear|swimwear|swimsuit|swimsuits
sports_bra|sports bra|sports bras
polo_shirt|polo shirt|polo shirts`,
BEAUTY:`cleanser|facial cleanser|face wash
moisturizer|moisturizer|moisturiser
face_serum|face serum|facial serum
facial_toner|facial toner|face toner
lip_balm|lip balm
mascara|mascara
eyeliner|eyeliner
eyeshadow|eyeshadow|eye shadow
foundation|makeup foundation
concealer|concealer
blush|blush|blusher
nail_polish|nail polish|nail varnish
makeup_remover|makeup remover
body_lotion|body lotion
body_wash|body wash|shower gel
hand_cream|hand cream
hair_mask|hair mask
hair_oil|hair oil
dry_shampoo|dry shampoo
perfume|perfume|perfumes
beard_oil|beard oil
makeup_brush|makeup brush|makeup brushes`,
PHARMACY:`first_aid_kit|first aid kit|first aid kits
sterile_gauze|sterile gauze|gauze pads
medical_tape|medical tape|surgical tape
antiseptic_wipes|antiseptic wipes
saline_solution|saline solution
nasal_spray|nasal spray
eye_drops|eye drops|eyedrops
contact_lens_solution|contact lens solution
blood_pressure_monitor|blood pressure monitor|blood pressure monitors
pulse_oximeter|pulse oximeter|pulse oximeters
glucose_meter|glucose meter|blood glucose meter
heating_pad|heating pad|heating pads
ice_pack|ice pack|ice packs
knee_support|knee support|knee brace
ankle_support|ankle support|ankle brace
compression_stockings|compression stockings
pill_organizer|pill organizer|pill organiser
face_mask|medical face mask|surgical mask
hand_sanitizer|hand sanitizer|hand sanitiser
oral_rehydration_salts|oral rehydration salts`,
ELECTRONICS:`earbuds|earbuds|ear buds
smartwatch|smartwatch|smart watch
fitness_tracker|fitness tracker
power_bank|power bank|portable charger
phone_charger|phone charger
usb_cable|usb cable|usb cables
hdmi_cable|hdmi cable|hdmi cables
wireless_mouse|wireless mouse
webcam|webcam|webcams
router|router|routers
modem|modem|modems
printer|printer|printers
ink_cartridge|ink cartridge|ink cartridges
toner_cartridge|toner cartridge|toner cartridges
external_hard_drive|external hard drive|external hard drives
solid_state_drive|solid state drive|ssd
memory_card|memory card|memory cards
usb_flash_drive|usb flash drive|flash drive|thumb drive
game_console|game console|gaming console
microphone|microphone|microphones
projector|projector|projectors
phone_case|phone case|phone cases
screen_protector|screen protector|screen protectors`,
JEWELRY:`pendant|pendant|pendants
brooch|brooch|brooches
anklet|anklet|anklets
bangle|bangle|bangles
cufflinks|cufflinks|cuff links
charm|jewelry charm|jewellery charm
engagement_ring|engagement ring|engagement rings
wedding_band|wedding band|wedding bands
signet_ring|signet ring|signet rings
stud_earrings|stud earrings
hoop_earrings|hoop earrings
drop_earrings|drop earrings
chain_necklace|chain necklace|chain necklaces
locket|locket|lockets
tennis_bracelet|tennis bracelet|tennis bracelets
jewelry_box|jewelry box|jewellery box
jewelry_cleaner|jewelry cleaner|jewellery cleaner
watch_strap|watch strap|watch straps`,
HOME:`mattress|mattress|mattresses
pillow|pillow|pillows
pillowcase|pillowcase|pillowcases
duvet|duvet|duvets
duvet_cover|duvet cover|duvet covers
bed_sheet|bed sheet|bed sheets
blanket|blanket|blankets
bookshelf|bookshelf|bookshelves|bookcase
wardrobe|wardrobe|wardrobes
bedside_table|bedside table|nightstand
coffee_table|coffee table|coffee tables
desk|desk|desks
floor_lamp|floor lamp|floor lamps
ceiling_light|ceiling light|ceiling lights
mirror|mirror|mirrors
frying_pan|frying pan|skillet
saucepan|saucepan|saucepans
cutlery|cutlery|flatware
kettle|kettle|kettles
toaster|toaster|toasters
vacuum_cleaner|vacuum cleaner|vacuum cleaners
laundry_basket|laundry basket|laundry hamper
storage_box|storage box|storage boxes
bath_mat|bath mat|bath mats`,
AUTOMOTIVE:`brake_pads|brake pads
brake_discs|brake discs|brake rotors
spark_plug|spark plug|spark plugs
oil_filter|oil filter|oil filters
air_filter|engine air filter|engine air filters
cabin_air_filter|cabin air filter|cabin air filters
fuel_filter|fuel filter|fuel filters
coolant|engine coolant|antifreeze
brake_fluid|brake fluid
transmission_fluid|transmission fluid
headlight_bulb|headlight bulb|headlight bulbs
jumper_cables|jumper cables|jump leads
car_jack|car jack|car jacks
tire_inflator|tire inflator|tyre inflator
wheel_cover|wheel cover|hubcap|hubcaps
car_floor_mat|car floor mat|car floor mats
seat_cover|car seat cover|car seat covers
dash_camera|dash camera|dash cam|dashcam
car_shampoo|car shampoo|car wash shampoo
car_wax|car wax
steering_wheel_cover|steering wheel cover`,
B2B:`hex_nut|hex nut|hex nuts
flat_washer|flat washer|flat washers
wall_anchor|wall anchor|wall anchors
cable_tie|cable tie|cable ties|zip tie|zip ties
safety_goggles|safety goggles
hard_hat|hard hat|hard hats|safety helmet
high_visibility_vest|high visibility vest|hi vis vest
hearing_protection|hearing protection|ear defenders
steel_toe_boots|steel toe boots|safety boots
shipping_box|shipping box|shipping boxes
bubble_wrap|bubble wrap
stretch_film|stretch film|pallet wrap
shipping_label|shipping label|shipping labels
wooden_pallet|wooden pallet|wooden pallets
pallet_jack|pallet jack|pallet truck
hand_truck|hand truck|hand trucks
industrial_shelving|industrial shelving|warehouse shelving
ball_bearing|ball bearing|ball bearings
pipe_fitting|pipe fitting|pipe fittings
hex_key|hex key|hex keys|allen key|allen keys
torque_wrench|torque wrench|torque wrenches
abrasive_disc|abrasive disc|abrasive discs`
};
const shared:Record<string,string>={
COLOR:`navy|navy|navy blue
beige|beige
burgundy|burgundy
teal|teal
ivory|ivory
cream|cream colored|cream coloured
charcoal|charcoal gray|charcoal grey
purple|purple
orange|orange colored|orange coloured
multicolor|multicolor|multicolour`,
MATERIAL:`stainless_steel|stainless steel
aluminum|aluminum|aluminium
bamboo|bamboo
ceramic|ceramic
silicone|silicone
polyester|polyester
nylon|nylon
velvet|velvet
satin|satin
cashmere|cashmere
platinum|platinum
sterling_silver|sterling silver
rose_gold|rose gold
rubber|rubber
plastic|plastic`
};
function rows(text:string,type:string,industry:string):Alias[]{return text.split('\n').flatMap(line=>{const [value,...aliases]=line.split('|');return aliases.map(alias=>({value,alias,type,industry}));});}
export const industryTerms:Alias[]=[...Object.entries(categories).flatMap(([industry,text])=>rows(text,'CATEGORY',industry)),...Object.entries(shared).flatMap(([type,text])=>rows(text,type,'CORE'))];
