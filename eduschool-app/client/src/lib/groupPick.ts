// Experimental "Выбрать группу" flow (Schedule create-block form ⇄ Groups page).
// The form draft is stashed in sessionStorage under this key while the user
// picks a group on the Groups page, then consumed on return. Same-tab only.
// Shape: { ci, sid, cellDateIso, form, picked?: { id, level, grammarTeacherId, clubTeacherId } }
export const GROUP_PICK_KEY = 'schedule.groupPick';
