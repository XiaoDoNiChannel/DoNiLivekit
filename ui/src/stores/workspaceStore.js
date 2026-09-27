import { reactive } from 'vue';
export const workspaceStore = reactive({
    supported: false, cards: [], busy: false, error: '', viewChannel: '',
    channelDialog: null, cardDialog: null,
});
