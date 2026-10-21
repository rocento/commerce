import { ProductPromptStore } from '../core/productPromptStore';
import { AssistantProposalStore } from '../core/assistantProposalStore';
import { AssistantStore, type AssistantTurn } from '../core/assistantStore';
import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ActivityIndicator, FlatList, TextInput, View } from 'react-native';
import { CommerceClient, type Locale } from '../core/commerce';
import { isID, list, object, text, type AssistantBlock, type Json } from '../core/assistant';
import { Button, Copy, Row, UiContext } from './Storefront';
import { AmountRow } from './ScreenParts';
import { ProductThumbnail } from './DiscoveryScreens';
import { NavigationIcon } from './NavigationIcon';
import type { AssistantLibrary } from '../core/assistantLibrary';
import { AssistantLibraryPanel } from './AssistantLibraryPanel';

type Destination = 'bag' | 'account' | 'catalog' | 'wishlist' | 'addresses';
type Actions = { client: CommerceClient; locale: Locale; locked: boolean; navigate: (destination: Destination) => void; openProduct: (id: string) => void; addProduct: (id: string) => void; settled: () => Promise<void>; applyProposal: (id: string) => Promise<void>; send: (message: string, product?: string, cart?: boolean) => void };
export function AssistantPanel({ client, locale, visible, locked, navigate, openProduct, addProduct, settled, applyProposal, store, feedback, optionsOpen, closeOptions, openSupport, openTickets, library, run }: Omit<Actions, 'send'> & { library:AssistantLibrary;run:(work:()=>Promise<void>)=>Promise<void>;openSupport?: (id:string)=>void; openTickets: () => void; optionsOpen?: boolean; closeOptions?: () => void; visible: boolean; feedback?: ReactNode; store: AssistantStore }) {
  const { colors, rtl } = useContext(UiContext), t = (en: string, ar: string) => locale === 'ar' ? ar : en;
  const { turns, draft, busy, stage, signIn } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const scroll = useRef<FlatList<AssistantTurn>>(null);
  const [libraryOpen,setLibraryOpen]=useState(false);
  const setDraft = (value: string) => store.setDraft(value);
  const reset = () => store.reset();
  useEffect(() => { if (!visible) store.stop(); return () => store.stop(); }, [store, visible]);
  const send = (value: string, product?: string, cart = false) => store.send(value, {
    product, cart, locked, settled, checkout: () => navigate('bag'),
  });
  // Match the storefront's welcome actions; tickets open the support list.
  const suggestions = [
    { label: t('Where is my last order?', 'أين طلبي الأخير؟'), message: t('Where is my last order?', 'أين طلبي الأخير؟') },
    { label: t('Recommended today', 'ترشيحات اليوم'), message: t('Recommend a product for today', 'رشّح لي منتجاً لليوم') },
    { label: t('Show my tickets', 'اعرض تذاكري'), message: null },
    { label: t('Find best sellers', 'الأكثر مبيعاً'), message: t('Recommend best-selling products', 'رشّح لي المنتجات الأكثر مبيعاً') },
    { label: t('Best discounts today', 'أفضل خصومات اليوم'), message: t('Recommend products with the best discounts today', 'رشّح لي المنتجات بأفضل الخصومات اليوم') },
    { label: t('Best value items', 'أفضل المنتجات قيمة'), message: t('Recommend the best value products', 'رشّح لي أفضل المنتجات قيمة مقابل السعر') },
  ];
  const actions: Actions = { client, locale, locked: locked || busy, navigate, openProduct, addProduct, settled, applyProposal, send: (m, p, c) => void send(m, p, c) };
  const progress = stage === 'catalog' ? t('Checking the catalog…', 'جارٍ البحث في المنتجات…') : stage === 'order' ? t('Checking your order…', 'جارٍ التحقق من طلبك…') : stage === 'support' ? t('Contacting support…', 'جارٍ التواصل مع الدعم…') : stage === 'responding' ? t('Writing a response…', 'جارٍ كتابة الرد…') : t('Understanding your request…', 'جارٍ فهم طلبك…');
  if(visible&&libraryOpen)return <AssistantLibraryPanel key={client.customer?.id??'guest'} library={library} chat={store} owner={client.customer?.id} locale={locale} locked={locked} run={run} close={()=>setLibraryOpen(false)} signIn={()=>{setLibraryOpen(false);navigate('account');}}/>;
  return <View style={{ flex: 1, display: visible ? 'flex' : 'none' }}>
    <FlatList ref={scroll} data={visible ? turns : []} keyExtractor={turn => turn.id}
      initialNumToRender={4} maxToRenderPerBatch={4} windowSize={5}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive"
      onContentSizeChange={() => { if (busy) scroll.current?.scrollToEnd({ animated: false }); }}
      contentContainerStyle={{ padding: 20, gap: 24 }}
      ListHeaderComponent={<View style={{ gap: 24 }}>
      {optionsOpen && <Row><View style={{ flex: 1 }}><Button title={t('View bag', 'عرض السلة')} secondary onPress={() => navigate('bag')} /></View><View style={{ flex: 1 }}><Button title={t('New conversation', 'محادثة جديدة')} secondary disabled={busy} onPress={() => { reset(); closeOptions?.(); }} /></View></Row>}
      {feedback}
      <Button title={t('Conversations & memory','المحادثات والذاكرة')} secondary disabled={locked||busy} onPress={()=>{closeOptions?.();setLibraryOpen(true);}}/>
      {!turns.length && <View style={{ gap: 14, paddingVertical: 20 }}><NavigationIcon name="assistant" color={colors.primary} /><Copy accessibilityRole="header" style={{ fontSize: 24, fontWeight: '700' }}>{t('Find something you’ll love', 'اعثر على ما يناسبك')}</Copy><Copy style={{ color: colors.muted }}>{t('Ask for recommendations, compare products, or get help with your bag.', 'اطلب ترشيحات أو قارن المنتجات أو احصل على مساعدة في سلتك.')}</Copy>{suggestions.map(suggestion => <Button key={suggestion.label} title={suggestion.label} secondary disabled={locked || busy} onPress={() => suggestion.message === null ? openTickets() : void send(suggestion.message)} />)}</View>}
      </View>}
      renderItem={({ item: turn, index }) => <View style={{ gap: 16 }}>
        <View style={{ alignSelf: rtl ? 'flex-start' : 'flex-end', backgroundColor: colors.tint, padding: 14, borderRadius: 18, maxWidth: '92%' }}><Copy selectable>{turn.question}</Copy></View>
        {!!turn.reply.text && <Copy selectable accessibilityLiveRegion="polite">{turn.reply.text}</Copy>}
        {turn.reply.blocks.map((block, i) => <RichBlock key={i} block={block} {...actions} />)}
        {!!turn.reply.order && <Button title={`${t('View order', 'عرض الطلب')} #${Number(object(turn.reply.order).number) || ''}`} secondary onPress={() => navigate('account')} />}
        {!!turn.reply.ticket && <Copy>{t('Your support request has been received.', 'تم استلام طلب الدعم.')}</Copy>}
        {!!client.customer && !!openSupport && isID(object(object(turn.reply.ticket).ticket).id) && <Button title={t('View support ticket','عرض تذكرة الدعم')} secondary disabled={locked||busy} onPress={()=>openSupport(text(object(object(turn.reply.ticket).ticket).id))}/>}
        {turn.reply.needsLogin && <Button title={t('Sign in', 'تسجيل الدخول')} onPress={() => navigate('account')} />}
        {turn.reply.needsAddress && <Button title={t('Choose delivery address', 'اختيار عنوان التوصيل')} onPress={() => navigate('addresses')} />}
        {index === turns.length - 1 && turn.reply.clarification && <><Copy style={{ fontWeight: '600' }}>{turn.reply.clarification.question}</Copy>{turn.reply.clarification.choices?.map(choice => <Button key={choice} title={choice} secondary disabled={locked || busy} onPress={() => void send(choice)} />)}</>}
        {turn.interrupted && <><Copy style={{ color: colors.muted }}>{t('Response interrupted. Check your bag before sending again; changes may already have been applied.', 'انقطع الرد. تحقق من سلتك قبل الإرسال مجدداً؛ ربما تم تطبيق تغييرات بالفعل.')}</Copy><Button title={t('Check bag', 'التحقق من السلة')} secondary onPress={() => navigate('bag')} /></>}
      </View>}
      ListFooterComponent={<View style={{ gap: 24 }}>
      {busy && <Row><ActivityIndicator color={colors.primary} /><Copy>{progress}</Copy></Row>}
      {signIn && <Button title={t('Sign in to continue', 'سجّل الدخول للمتابعة')} onPress={() => navigate('account')} />}
    </View>} />
    <View style={{ borderTopWidth: 1, borderColor: colors.border, padding: 16, gap: 8 }}>
      {locked && <Copy style={{ fontSize: 12 }}>{t('Finish the current update or resolve your pending checkout before changing your bag.', 'أكمل التحديث أو تحقق من طلبك المعلّق قبل تعديل السلة.')}</Copy>}
      <Row><TextInput accessibilityLabel={t('Ask your shopping assistant', 'اسأل مساعد التسوق')} placeholder={t('Ask your shopping assistant…', 'اسأل مساعد التسوق…')} placeholderTextColor={colors.muted} multiline value={draft} onChangeText={setDraft} editable={!locked && !busy} style={{ flex: 1, minHeight: 50, maxHeight: 130, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 12, color: colors.text, fontSize: 16, textAlign: rtl ? 'right' : 'left' }} />{busy ? <Button title={t('Stop', 'إيقاف')} label={t('Stop response', 'إيقاف الرد')} onPress={() => store.stop()} /> : <Button title="↑" label={t('Send message', 'إرسال الرسالة')} disabled={locked || !draft.trim() || [...draft].length > 4000} onPress={() => void send(draft)} />}</Row>
      {[...draft].length > 4000 && <Copy style={{ color: '#A63125', fontSize: 12 }}>{t('Use 4,000 characters or fewer.', 'استخدم ٤٠٠٠ حرف أو أقل.')}</Copy>}
    </View>
  </View>;
}
function RichBlock({ block, ...actions }: { block: AssistantBlock } & Actions) {
  const { locale, locked, navigate, openProduct, addProduct, send } = actions;
  const { colors } = useContext(UiContext), t = (en: string, ar: string) => locale === 'ar' ? ar : en;
  const kind = block.kind, removal = object(block.cart_removal), choices = object(block.cart_removal_choice), cart = object(block.cart), action = object(block.action);
  return <View style={{ gap: 12 }}>
    {!!block.title && <Copy style={{ fontSize: 17, fontWeight: '600' }}>{block.title}</Copy>}{!!block.text && <Copy selectable>{block.text}</Copy>}
    {block.products?.map(p => <View key={p.id} style={{ gap: 12, padding: 16, borderRadius: 18, backgroundColor: colors.surface }}>
      <Row><ProductThumbnail product={{ ...p, attributes: undefined, description: '', in_stock: p.in_stock !== false, media_ids: p.image_id ? [p.image_id] : [] }} /><View style={{ flex: 1, gap: 8 }}><Copy style={{ fontWeight: '600' }}>{p.name}</Copy><Copy>{p.price} {p.currency}</Copy>{p.original_price && <Copy style={{ fontSize: 12, textDecorationLine: 'line-through' }}>{p.original_price} {p.currency}</Copy>}</View></Row>
      {p.reasons.map((v, i) => <Copy key={`r${i}`}>{v}</Copy>)}{p.unmet.map((v, i) => <Copy key={`u${i}`} style={{ fontSize: 12 }}>{v}</Copy>)}{p.attributes.slice(0, 5).map((v, i) => <Copy key={`a${i}`} style={{ fontSize: 12 }}>{v.name}: {v.value}</Copy>)}
      <Button title={t('View product', 'عرض المنتج')} secondary onPress={() => openProduct(p.id)} /><Button title={t('Add to bag', 'إضافة للسلة')} disabled={locked || p.in_stock === false} onPress={() => addProduct(p.id)} /><Button title={t('Ask about this product', 'اسأل عن هذا المنتج')} secondary disabled={locked} onPress={() => send(t('Tell me more about this product', 'أخبرني المزيد عن هذا المنتج'), p.id)} />
    </View>)}
    {block.rows?.map((row, i) => <View key={i} style={{ gap: 6 }}><Copy style={{ fontWeight: '600' }}>{row.label}</Copy>{block.products?.map((p, j) => <Copy key={p.id}>{p.name}: {row.values[j]}</Copy>)}</View>)}
    {kind === 'cart_summary' && <><BasketItems items={cart.items} /><Copy style={{ fontWeight: '600' }}>{t('Subtotal', 'المجموع الفرعي')}: {text(cart.subtotal)} {text(cart.currency)}</Copy><Button title={t('View bag & checkout', 'عرض السلة وإتمام الطلب')} secondary onPress={() => navigate('bag')} /></>}
    {kind === 'cart_removal' && <><Copy>{text(removal.name)} · {t('Remaining', 'المتبقي')}: {Number(removal.remaining_quantity) || 0}</Copy><Button title={t('View bag', 'عرض السلة')} onPress={() => navigate('bag')} /></>}
    {kind === 'cart_removal_choice' && list(choices.items).map((value, i) => { const item = object(value); return <Button key={i} title={text(item.name)} secondary disabled={locked || !isID(item.product_id)} onPress={() => send(Number(choices.quantity) > 0 ? `Remove ${Number(choices.quantity)} of this product from my cart` : 'Remove this product from my cart', text(item.product_id))} />; })}
    {kind === 'saved_addresses' && <Button title={t('Choose delivery address', 'اختيار عنوان التوصيل')} onPress={() => navigate('addresses')} />}
    {['wishlist_manage', 'wishlist_transfer'].includes(kind) && <Button title={t('Open wishlist', 'فتح المفضلة')} onPress={() => navigate('wishlist')} />}
    {kind === 'action' && <Button title={text(action.label) || t('Browse products', 'تصفح المنتجات')} onPress={() => navigate('catalog')} />}
    {kind === 'compound_choice' && <Copy>{t('Reply with the product and action you want to use.', 'أجب بالمنتج والإجراء الذي تريده.')}</Copy>}
    {kind === 'basket_proposal' && block.proposal_id && <Proposal id={block.proposal_id} {...actions} />}
    {kind === 'product_prompt' && block.product_prompt && <ProductPrompt prompt={block.product_prompt} {...actions} />}
  </View>;
}
function BasketItems({ items }: { items: unknown }) { return <>{list(items).map((value, i) => { const item = object(value); return <Copy key={i}>{Number(item.quantity) || 0} × {text(item.name)} · {text(item.line_total)} {text(item.currency)}</Copy>; })}</>; }
function Proposal({ id, client, locale, locked, navigate, settled, applyProposal }: { id: string } & Actions) {
  const { colors } = useContext(UiContext), t = (en: string, ar: string) => locale === 'ar' ? ar : en;
  const store = useMemo(() => new AssistantProposalStore(id, client), [id, client]);
  const { proposal, busy, pending, issue } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const reload = () => store.reload(settled);
  useEffect(() => { void reload(); return () => store.reset(); }, [store]);
  const p = object(proposal), draft = object(p.draft), totals = object(p.after), canApply = store.canApply;
  const error = issue === 'load' ? t('Unable to load this proposal. Sign in and try again.', 'تعذر تحميل المقترح. سجّل الدخول وحاول مجدداً.')
    : issue === 'unconfirmed' ? t('The outcome is not confirmed. Check again before making more changes.', 'لم يتم تأكيد النتيجة. تحقق مجدداً قبل إجراء تغييرات أخرى.')
    : issue === 'apply' ? t('Unable to confirm the update. Check its status before approving again.', 'تعذر تأكيد التحديث. تحقق من حالته قبل الموافقة مجدداً.') : '';
  const apply = () => { if (!client.customer) { navigate('account'); return; } return store.apply(applyProposal, settled, locked); };
  return <View style={{ gap: 12, padding: 16, borderRadius: 16, backgroundColor: colors.surface }}><Copy style={{ fontWeight: '600' }}>{t('Review proposed basket', 'مراجعة السلة المقترحة')}</Copy>
    {proposal && <><Copy>{text(object(draft.goal).purpose)}</Copy><Copy style={{ fontWeight: '600' }}>{t('Current basket', 'السلة الحالية')}</Copy><BasketItems items={p.current_items} /><Copy style={{ fontWeight: '600' }}>{t('Basket after approval', 'السلة بعد الموافقة')}</Copy><BasketItems items={p.resulting_items} />
      {(['subtotal', 'discount', 'tax', 'delivery', 'payable'] as const).map((key, i) => <AmountRow key={key} label={[t('Subtotal', 'المجموع الفرعي'), t('Discount', 'الخصم'), t('Tax', 'الضريبة'), t('Delivery', 'التوصيل'), t('Total', 'الإجمالي')][i]!} value={`${text(totals[key]) || t('Not yet verified', 'لم يتم التحقق بعد')} ${text(totals.currency)}`} />)}
      {[...list(p.issues), ...list(p.notes)].map((v, i) => <Copy key={i}>{text(v)}</Copy>)}<Copy style={{ fontSize: 12 }}>{t('Valid until', 'صالح حتى')}: {text(p.expires_at)}</Copy>
      {p.applied === true ? <><Copy>{t('Applied to your bag. Review checkout separately to place your order.', 'تم التطبيق على سلتك. راجع إتمام الطلب بشكل منفصل لتأكيده.')}</Copy><Button title={t('View bag & checkout', 'عرض السلة وإتمام الطلب')} onPress={() => navigate('bag')} /></> : <><Copy style={{ fontSize: 12 }}>{t('Approval changes your bag; it does not place an order.', 'الموافقة تعدّل السلة ولا تؤكد الطلب.')}</Copy><Button title={pending ? t('Check update status', 'تحقق من حالة التحديث') : t('Approve & apply to bag', 'الموافقة والتطبيق على السلة')} disabled={busy || locked || (!pending && !canApply)} onPress={() => void (pending ? reload() : apply())} /></>}
    </>}
    {!!error && <Copy accessibilityRole="alert">{error}</Copy>}{busy && <ActivityIndicator color={colors.primary} />}<Button title={t('Refresh proposal', 'تحديث المقترح')} secondary disabled={busy || locked} onPress={() => void reload()} />
  </View>;
}
function ProductPrompt({ prompt, client, locale, locked, openProduct, send }: { prompt: Json } & Actions) {
  const t = (en: string, ar: string) => locale === 'ar' ? ar : en, p = object(prompt), query = text(p.query), action = text(p.action) || 'choose';
  const store = useMemo(() => new ProductPromptStore(), [client, query]);
  const { products, selected, busy, failed } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    void store.load(async signal => (await client.search(query.slice(0, 120), '', 0, signal)).hits);
    return () => store.reset();
  }, [store, locale, revision]);
  return <View style={{ gap: 12 }}><Copy style={{ fontWeight: '600' }}>{t('Choose a product', 'اختر منتجاً')}: {query}</Copy>{busy && <ActivityIndicator />}{failed && <Button title={t('Retry product search', 'إعادة البحث عن المنتجات')} onPress={() => setRevision(v => v + 1)} />}{!busy && !failed && !products.length && <Copy>{t('No matching products. Try another name.', 'لا توجد منتجات مطابقة. جرّب اسماً آخر.')}</Copy>}
    {products.map(product => <View key={product.id} style={{ gap: 12 }}><Row><ProductThumbnail product={product} size={64} /><View style={{ flex: 1 }}><Copy>{product.name}</Copy><Copy>{product.price} {product.currency}</Copy></View></Row>{action === 'compare' ? <Button title={t('Compare this product', 'مقارنة هذا المنتج')} selected={selected.includes(product.id)} secondary disabled={locked} onPress={() => store.select(product.id)} /> : <><Button title={t('View product', 'عرض المنتج')} secondary onPress={() => openProduct(product.id)} />{product.product_type === 'simple' && <>{['cart', 'choose'].includes(action) && <Button title={t('Add to bag', 'إضافة للسلة')} disabled={locked || !product.in_stock} onPress={() => send(`Add ${Math.min(1000000, Math.max(1, Number(p.quantity) || 1))} of this product to cart`, product.id)} />}{['wishlist', 'choose'].includes(action) && <Button title={t('Save to wishlist', 'حفظ في المفضلة')} secondary disabled={locked} onPress={() => send('Add 1 of this product to wishlist', product.id)} />}{action === 'remove' && <Button title={t('Remove from bag', 'حذف من السلة')} disabled={locked} onPress={() => send('Remove this product from cart', product.id)} />}</>}</>}</View>)}
    {action === 'compare' && <Button title={t('Compare selected products', 'مقارنة المنتجات المحددة')} disabled={locked || selected.length < 2 || selected.length > 5} onPress={() => send('Compare ' + selected.map(id => `/products/${id}`).join(' and '))} />}
  </View>;
}
