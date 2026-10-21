import { CommerceError, validPin, type CommerceClient, type DeliveryRequest, type Fulfillment, type Location } from './commerce';
import { CheckoutFlow } from './checkout';
import { FeatureState } from './featureState';

export type AddressDraft = Readonly<{ locationMethod: 'pin' | 'neighborhood'; geography: Record<string, string> | null; address: string; latitude: string; longitude: string; building: string; floor: string; apartment: string; instructions: string }>;
const emptyAddress = (): AddressDraft => ({ locationMethod: 'pin', geography: null, address: '', latitude: '', longitude: '', building: '', floor: '', apartment: '', instructions: '' });
const today = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
export type DeliveryState = Readonly<{ locations: Location[]; availability: Fulfillment | null; locationID: string; guestAddress: string | null; method: string; pickup: string; date: string; asap: boolean; addressDraft: AddressDraft }>;
const initial = (): DeliveryState => ({ locations: [], availability: null, locationID: '', guestAddress: null, method: 'delivery', pickup: '', date: today(), asap: true, addressDraft: emptyAddress() });
type DeliveryClient = Pick<CommerceClient, 'locations' | 'fulfillment' | 'coverage' | 'saveLocation' | 'pin'>;
export class DeliveryForm extends FeatureState<DeliveryState> {
  constructor(private client: DeliveryClient, private checkout: CheckoutFlow) { super(initial()); }
  reset() { this.generation++; this.client.pin = null; this.publish(initial()); }
  get request(): DeliveryRequest {
    const { method, locationID, pickup, date, asap } = this.state;
    return { method, location_id: method === 'delivery' ? locationID || null : null, source_id: method === 'pickup' ? pickup || null : null, date, asap };
  }
  update(change: Partial<Pick<DeliveryState, 'method' | 'pickup' | 'date' | 'asap'>>) {
    if (this.checkout.locked || this.checkout.busy) return;
    let next = { ...this.state, ...change };
    if (next.method !== this.state.method) {
      const method = next.availability?.methods.find(value => value.type === next.method);
      next = { ...next, asap: method?.asap === true, pickup: method?.locations?.[0]?.id ?? '' };
    }
    this.checkout.invalidate(); this.publish(next);
  }
  editAddress(change: Partial<AddressDraft>) {
    if (!this.checkout.locked) this.publish({ ...this.state, addressDraft: { ...this.state.addressDraft, ...change } });
  }
  clearAddress() { this.publish({ ...this.state, addressDraft: emptyAddress() }); }
  async refresh() {
    const revision = this.generation;
    const [locations, availability] = await Promise.all([this.client.locations(), this.client.fulfillment()]); this.checkRevision(revision);
    let next = { ...this.state, locations, availability };
    if (!this.checkout.locked || !next.locationID) {
      const chosen = locations.find(value => value.id === next.locationID) ?? locations.find(value => value.is_default) ?? locations[0];
      const method = availability.methods.find(value => value.type === next.method) ?? availability.methods[0];
      next = { ...next, locationID: chosen?.id ?? '', method: method?.type ?? 'delivery', asap: next.asap && method?.asap === true,
        pickup: method?.locations?.find(value => value.id === next.pickup)?.id ?? method?.locations?.[0]?.id ?? '' };
    }
    this.client.pin = locations.find(value => value.id === next.locationID) ?? null;
    this.publish(next);
  }
  async choose(value: Location) {
    this.checkEditable(); const revision = this.generation;
    const oldPin = this.client.pin; this.client.pin = value;
    try {
      const coverage = await this.client.coverage(); this.checkRevision(revision);
      if (coverage.configured && !coverage.deliverable) throw new CommerceError(422, 'Outside the delivery area');
      this.checkout.invalidate(); this.publish({ ...this.state, locationID: value.id });
    } catch (error) { if (revision === this.generation) this.client.pin = oldPin; throw error; }
  }
  async saveAddress(guest = false) {
    this.checkEditable(); const revision = this.generation;
    const draft = this.state.addressDraft;
    const pin = { latitude: Number(draft.latitude), longitude: Number(draft.longitude) };
    if (!draft.latitude.trim() || !draft.longitude.trim() || !validPin(pin) || !draft.address.trim()) throw new CommerceError(422, 'Enter a valid delivery pin and address.');
    const oldPin = this.client.pin; this.client.pin = pin;
    try {
      const coverage = await this.client.coverage(); this.checkRevision(revision);
      if (coverage.configured && !coverage.deliverable) throw new CommerceError(422, 'Outside the delivery area');
      if (guest) {
        this.checkout.invalidate(); this.publish({ ...this.state, guestAddress: draft.address, locationID: '' }); this.clearAddress(); return;
      }
      const saved = await this.client.saveLocation({ ...pin, location_method: draft.locationMethod, geography: draft.geography, formatted_address: draft.address, building: draft.building, floor: draft.floor, apartment: draft.apartment, delivery_instructions: draft.instructions });
      this.checkRevision(revision); this.checkout.invalidate(); this.publish({ ...this.state, locationID: saved.id });
      await this.refresh(); this.clearAddress();
    } catch (error) { if (revision === this.generation) this.client.pin = oldPin; throw error; }
  }
  private checkEditable() { if (this.checkout.locked) throw new CommerceError(409, 'Resolve the previous checkout first'); }
}
