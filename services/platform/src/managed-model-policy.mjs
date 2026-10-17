export const validManagedModelId = value => typeof value === 'string' && value.length > 0 && value.length <= 160 &&
 !/[\x00-\x20\x7f]/.test(value);

export const validManagedModelIds = ids => Array.isArray(ids) && ids.length > 0 && ids.length <= 256 &&
 ids.every(validManagedModelId) && new Set(ids).size === ids.length;

// The caller must supply the trusted service profile, never a tenant catalog.
export function validManagedModelSelection(profile) {
 const ids = Array.isArray(profile?.models) ? profile.models.map(model => model?.id) : null;
 return validManagedModelIds(ids) && ids.includes(profile.defaultModel);
}
