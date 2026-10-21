import {expect,type Locator} from '@playwright/test';
// Browser geolocation is stubbed; these coordinates never come from the device.
export async function fillPreviewAddress(device:Locator) {
 const context=device.page().context();
 await context.setGeolocation({latitude:30.0444,longitude:31.2357});
 await context.grantPermissions(['geolocation']);
 await device.getByRole('button',{name:'Use current location',exact:true}).click();
 await expect(device.getByText('Pin selected. You can move it on the map.',{exact:true})).toBeVisible();
 await device.getByLabel('Street and address',{exact:true}).fill('12 Demo Street, Cairo');
}
