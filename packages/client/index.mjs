import { PlatformClient as VendorClient, PlatformError } from '../../vendor/freedom-platform/client.mjs';

const originalAssertCompatible = VendorClient.prototype.assertCompatible;
VendorClient.prototype.assertCompatible = function() {
    if (!this._compatiblePromise) {
        this._compatiblePromise = originalAssertCompatible.call(this).catch(e => {
            this._compatiblePromise = undefined;
            throw e;
        });
    }
    return this._compatiblePromise;
};

export { VendorClient as PlatformClient, PlatformError };
