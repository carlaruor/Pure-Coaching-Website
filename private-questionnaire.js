'use strict';

(() => {
  const form = document.querySelector('[data-private-questionnaire]');
  if (!form) return;

  const participantFields = form.querySelector('[data-questionnaire-participant]');
  const relationshipOtherField = form.querySelector('[data-questionnaire-relationship-other]');

  function updateParticipantFields() {
    const sessionsFor = form.querySelector('input[name="sessionsFor"]:checked')?.value || '';
    const forSomeoneElse = sessionsFor === 'Someone else';
    participantFields.hidden = !forSomeoneElse;
    participantFields.querySelectorAll('input, select').forEach((control) => {
      control.disabled = !forSomeoneElse;
      control.required = forSomeoneElse;
      if (!forSomeoneElse) control.value = '';
    });

    const relationship = form.elements.relationshipToParticipant;
    const otherRelationship = forSomeoneElse && relationship.value === 'Other';
    relationshipOtherField.hidden = !otherRelationship;
    form.elements.relationshipOther.disabled = !otherRelationship;
    form.elements.relationshipOther.required = otherRelationship;
    if (!otherRelationship) form.elements.relationshipOther.value = '';
  }

  form.addEventListener('change', updateParticipantFields);
  updateParticipantFields();
})();
