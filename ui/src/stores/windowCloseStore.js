import { reactive } from 'vue';

export const windowCloseStore = reactive({
    open: false, busy: false, error: '',
    preference: 'ask', remember: false, preferenceError: '',
});
