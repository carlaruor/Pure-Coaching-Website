'use strict';

function initIntakeForm() {
  const form = document.querySelector('[data-intake-form]');

  if (!form) return;

  const steps = Array.from(form.querySelectorAll('[data-form-step]'));
  const progressItems = Array.from(document.querySelectorAll('[data-progress-step]'));
  const nextButton = form.querySelector('[data-form-next]');
  const backButton = form.querySelector('[data-form-back]');
  const submitButton = form.querySelector('[data-form-submit]');
  const status = form.querySelector('[data-form-status]');
  const confirmation = document.querySelector('[data-form-confirmation]');
  const review = form.querySelector('[data-form-review]');
  const context = document.querySelector('[data-form-context]');
  const state = { step: 1, support: '', intent: '' };

  form.querySelectorAll('[data-error-for]').forEach((error) => {
    const name = error.dataset.errorFor;
    const errorId = `${name}-error`;
    error.id = errorId;
    form.querySelectorAll(`[name="${name}"]`).forEach((control) => {
      const descriptions = new Set((control.getAttribute('aria-describedby') || '').split(' ').filter(Boolean));
      descriptions.add(errorId);
      control.setAttribute('aria-describedby', Array.from(descriptions).join(' '));
    });
  });

  const field = (name) => form.elements.namedItem(name);
  const selected = (name) => form.querySelector(`input[name="${name}"]:checked`);
  const value = (name) => {
    const control = field(name);
    return control ? String(control.value).trim() : '';
  };

  function setError(name, message) {
    const error = form.querySelector(`[data-error-for="${name}"]`);
    const control = field(name);
    if (error) error.textContent = message;
    if (control && !control.length) control.setAttribute('aria-invalid', 'true');
  }

  function clearErrors(step) {
    step.querySelectorAll('.field-error').forEach((error) => { error.textContent = ''; });
    step.querySelectorAll('[aria-invalid="true"]').forEach((control) => control.removeAttribute('aria-invalid'));
    status.hidden = true;
  }

  function updateConditionals() {
    const roleOther = document.querySelector('[data-role-other]');
    const personFields = document.querySelector('[data-person-fields]');
    const ndisQuestion = document.querySelector('[data-ndis-question]');
    const privateNote = document.querySelector('[data-private-note]');
    const childNote = document.querySelector('[data-child-note]');
    const timeOther = document.querySelector('[data-time-other]');
    const contactFor = selected('contactFor')?.value || '';
    const support = selected('support')?.value || '';

    roleOther.hidden = value('role') !== 'Other';
    field('roleOther').required = !roleOther.hidden;
    personFields.hidden = contactFor !== 'Someone else';
    field('personFirstName').required = !personFields.hidden;
    field('personLastName').required = !personFields.hidden;
    ndisQuestion.hidden = support !== 'ndis';
    privateNote.hidden = support !== 'private';
    childNote.hidden = support !== 'child-safety';
    timeOther.hidden = value('contactTime') !== 'Other';
    field('contactTimeOther').required = !timeOther.hidden;
  }

  function validateStep(stepNumber) {
    const step = steps[stepNumber - 1];
    clearErrors(step);
    updateConditionals();
    let firstInvalid = null;

    const radioMessages = {
      contactFor: "Please select who you're contacting us for.",
      support: 'Please choose a support option.',
      ndisPlan: 'Please select an NDIS plan option.',
      ageRange: 'Please select an age range.',
      preferredContact: 'Please choose a preferred contact method.'
    };

    step.querySelectorAll('[data-required-group]').forEach((group) => {
      if (group.hidden) return;
      const name = group.dataset.requiredGroup;
      if (!selected(name)) {
        setError(name, radioMessages[name]);
        firstInvalid ||= group.querySelector('input');
      }
    });

    step.querySelectorAll('input[required], select[required], textarea[required]').forEach((control) => {
      if (control.closest('[hidden]') || control.type === 'radio' || control.type === 'checkbox') return;
      if (!control.validity.valid) {
        let message = `Please enter your ${control.labels?.[0]?.textContent.toLowerCase() || 'information'}.`;
        if (control.type === 'email' && control.validity.typeMismatch) message = 'Please enter a valid email address.';
        setError(control.name, message);
        firstInvalid ||= control;
      }
    });

    if (stepNumber === 5 && !field('consent').checked) {
      setError('consent', 'Please confirm that we may contact you about this enquiry.');
      firstInvalid ||= field('consent');
    }

    if (firstInvalid) {
      status.textContent = 'Please check the highlighted information before continuing.';
      status.hidden = false;
      firstInvalid.focus();
      return false;
    }
    return true;
  }

  function showStep(stepNumber) {
    state.step = stepNumber;
    steps.forEach((step, index) => { step.hidden = index + 1 !== stepNumber; });
    progressItems.forEach((item, index) => {
      const position = index + 1;
      item.classList.toggle('is-current', position === stepNumber);
      item.classList.toggle('is-complete', position < stepNumber);
      if (position === stepNumber) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    backButton.hidden = stepNumber === 1;
    nextButton.hidden = stepNumber === 5;
    submitButton.hidden = stepNumber !== 5;
    status.hidden = true;
    if (stepNumber === 5) renderReview();
    steps[stepNumber - 1].querySelector('h2').focus({ preventScroll: true });
    document.querySelector('.intake__surface').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function addReviewGroup(title, stepNumber, rows) {
    const section = document.createElement('section');
    const heading = document.createElement('h3');
    const edit = document.createElement('button');
    const list = document.createElement('dl');
    heading.textContent = title;
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => showStep(stepNumber));
    section.append(heading, edit);
    rows.filter((row) => row[1]).forEach(([label, detail]) => {
      const term = document.createElement('dt');
      const description = document.createElement('dd');
      term.textContent = label;
      description.textContent = detail;
      list.append(term, description);
    });
    section.append(list);
    review.append(section);
  }

  function renderReview() {
    review.replaceChildren();
    const contactFor = selected('contactFor')?.value || '';
    const supportLabels = { private: 'Private Support', ndis: 'NDIS Support', 'child-safety': 'Child Safety', unsure: "I'm not sure" };
    addReviewGroup('About you', 1, [
      ['Contacting for', contactFor], ['Role', value('role') === 'Other' ? value('roleOther') : value('role')],
      ['Name', `${value('firstName')} ${value('lastName')}`], ['Email', value('email')], ['Phone', value('phone')]
    ]);
    addReviewGroup('Support', 2, [['Support pathway', supportLabels[selected('support')?.value]], ['NDIS plan', selected('support')?.value === 'ndis' ? selected('ndisPlan')?.value : '']]);
    addReviewGroup('About the person', 3, [['Person being referred', contactFor === 'Someone else' ? `${value('personFirstName')} ${value('personLastName')}` : 'Myself'], ['Age range', selected('ageRange')?.value]]);
    addReviewGroup('Your message', 4, [['Preferred contact', selected('preferredContact')?.value], ['Best time', value('contactTime') === 'Other' ? value('contactTimeOther') : value('contactTime')], ['Message', value('message')]]);
  }

  function applyUrlContext() {
    const parameters = new URLSearchParams(window.location.search);
    const support = parameters.get('support');
    const intent = parameters.get('intent');
    const allowedSupport = ['private', 'ndis', 'child-safety', 'unsure'];
    const allowedIntent = ['enquiry', 'enrolment', 'referral', 'general'];
    state.support = allowedSupport.includes(support) ? support : '';
    state.intent = allowedIntent.includes(intent) ? intent : '';
    if (state.support) {
      const option = form.querySelector(`input[name="support"][value="${state.support}"]`);
      if (option) option.checked = true;
    }
    if (state.intent === 'referral') form.querySelector('input[name="contactFor"][value="Someone else"]').checked = true;
    if (state.intent === 'enrolment') form.querySelector('input[name="contactFor"][value="Myself"]').checked = true;
    const labels = { private: 'Private Support enquiry', ndis: `NDIS ${state.intent || 'enquiry'}`, 'child-safety': 'Child Safety enquiry', unsure: 'Support enquiry' };
    if (state.support && labels[state.support]) {
      context.textContent = labels[state.support];
      context.hidden = false;
    }
    updateConditionals();
  }

  nextButton.addEventListener('click', () => { if (validateStep(state.step)) showStep(state.step + 1); });
  backButton.addEventListener('click', () => showStep(state.step - 1));
  form.addEventListener('change', (event) => {
    updateConditionals();
    const error = form.querySelector(`[data-error-for="${event.target.name}"]`);
    if (error) error.textContent = '';
    event.target.removeAttribute('aria-invalid');
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!validateStep(5)) return;
    // Future backend/API submission should be connected here.
    form.hidden = true;
    document.querySelector('.intake-progress').hidden = true;
    context.hidden = true;
    confirmation.hidden = false;
    confirmation.focus();
  });

  steps.forEach((step) => step.querySelector('h2').setAttribute('tabindex', '-1'));
  applyUrlContext();
  showStep(1);
}

initIntakeForm();
