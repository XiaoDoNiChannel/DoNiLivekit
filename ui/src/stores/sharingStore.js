import { reactive } from 'vue';

export const createSharingState = () => ({
    shares: [], notices: [], watchingId: '', view: 'chat', endedName: '', error: '',
});
export const sharingStore = reactive(createSharingState());
