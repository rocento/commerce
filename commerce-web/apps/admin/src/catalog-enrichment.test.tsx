import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CatalogEnrichment, EnrichmentEvidence, enrichmentEligible, enrichmentValue } from './catalog-enrichment';
import { catalogSchemaApi, type AttributeDefinition } from '@commerce/api-client';

type Suggestion = Awaited<ReturnType<typeof catalogSchemaApi.suggestions>>[number];
const suggestion:Suggestion={id:'00000000-0000-0000-0000-000000000001',product_id:'00000000-0000-0000-0000-000000000002',definition_id:'00000000-0000-0000-0000-000000000003',value:'casual',source:'DERIVED',confidence:1,model_version:'labelled-description-v1',status:'pending',created_at:'2026-09-28T12:00:00Z',reviewed_at:null,reviewed_by:null,evidence:{field:'description',quote:'Style: <script>alert(1)</script>'}};

it('renders source evidence as text and distinguishes confidence from verification',()=>{
 const html=renderToStaticMarkup(<EnrichmentEvidence suggestion={suggestion}/>);
 expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');
 expect(html).toContain('Confidence does not verify the product claim');
});

it('identifies legacy suggestions without claiming they have evidence',()=>{
 const html=renderToStaticMarkup(<EnrichmentEvidence suggestion={{...suggestion,evidence:null}}/>);
 expect(html).toContain('Source evidence missing');
});

it('read-only reviewers see evidence and pagination without mutation controls',()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
 client.setQueryData(['catalog-enrichment','pending',undefined,undefined],[suggestion]);
 client.setQueryData(['attribute-definitions','product'],[]);
 const html=renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter><CatalogEnrichment canWrite={false}/></MemoryRouter></QueryClientProvider>);
 expect(html).toContain('read-only access');expect(html).toContain('Next suggestions');
 expect(html).not.toContain('Generate for selected product');
 expect(html).not.toContain('Confirm review');
 expect(html).toContain('image inference are not connected');
 client.clear();
});

const definition: AttributeDefinition = {id:'style',entity_type:'product',attribute_code:'style',label:'Style',input_type:'single_select',scope:'global',is_required:false,is_unique:false,is_searchable:false,is_filterable:false,is_comparable:false,is_visible_on_front:false,used_for_promo_rules:false,used_for_configurations:false,swatch_type:'none',options:[{value:'casual',label:'Casual'},{value:'formal',label:'Formal'}],version:1,metadata:{ai_enrichable:true,source_policy:'semantic',status:'active'}};
it('renders choice labels and multi-choice values without JSON punctuation',()=>{
 expect(enrichmentValue('casual',definition)).toBe('Casual');
 expect(enrichmentValue(['casual','formal'],definition)).toBe('Casual, Formal');
 expect(enrichmentValue('free text')).toBe('free text');
});
it('only counts supported active semantic attributes as eligible',()=>{
 expect(enrichmentEligible(definition)).toBe(true);
 expect(enrichmentEligible({...definition,input_type:'boolean'})).toBe(false);
 expect(enrichmentEligible({...definition,used_for_configurations:true})).toBe(false);
 expect(enrichmentEligible({...definition,metadata:{...definition.metadata,status:'disabled'}})).toBe(false);
 expect(enrichmentEligible({...definition,metadata:{...definition.metadata,source_policy:'trusted_only'}})).toBe(false);
});
