import { prepareNotices } from './notices.ts';

const inventory = await prepareNotices();
console.log(`Prepared ${inventory.components.length} component notice entries and ${Object.keys(inventory.files).length} files, with pinned source attribution and explicit coverage gaps.`);
