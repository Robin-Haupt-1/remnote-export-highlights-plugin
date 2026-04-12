import {declareIndexPlugin, type ReactRNPlugin, Rem} from '@remnote/plugin-sdk';
import '../style.css';
import '../index.css';
import {BuiltInPowerupCodes} from '@remnote/plugin-sdk';

async function findChildren(rem: Rem, plugin: ReactRNPlugin, level: number = 0) {
    for (const child of await rem.getChildrenRem()) {
        if (child.text.length > 0 && await child.hasPowerup('n')) {
            console.log("highlight text", child.text[0],)
            console.log("child", child)
            console.log("page", (await child.getParentRem())?.text)
        }
        await findChildren(child, plugin, level + 1);
    }
}

async function onActivate(plugin: ReactRNPlugin) {

// Step 1: Get all PDF document Rems
    const filePowerup = await plugin.powerup.getPowerupByCode(BuiltInPowerupCodes.UploadedFile);
    if (!filePowerup) return;
    const pdfRems = await filePowerup.taggedRem();

// Step 2: For each PDF, collect highlight children
    for (const pdfRem of pdfRems) {
        const pdfTitle = await plugin.richText.toString(pdfRem.text);
        const fileName = await pdfRem.getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'Name');
        const children = await pdfRem.getChildrenRem();

        console.log(`PDF: ${pdfTitle}`);
        await findChildren(pdfRem, plugin)
    }

}

async function onDeactivate(_: ReactRNPlugin) {
}

declareIndexPlugin(onActivate, onDeactivate);