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
  const finalStep = steps.length;
  const state = { step: 1, support: '', fixedSupport: '', intent: '' };

  const documentSection = form.querySelector('[data-ndis-documents]');
  const documentConfig = {
    maxSizeMB: 10,
    fields: { ndisPlanDocument: { limit: 1, label: 'NDIS Plan' }, supportingReports: { limit: 3, label: 'Supporting Reports' } },
    mimeTypes: { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
  };
  const documents = { ndisPlanDocument: [], supportingReports: [] };

  function renderDocuments(name) {
    const list = form.querySelector(`[data-document-list="${name}"]`);
    list.replaceChildren();
    documents[name].forEach((file, index) => {
      const item = document.createElement('li');
      const filename = document.createElement('span');
      const remove = document.createElement('button');
      filename.textContent = file.name;
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${file.name}`);
      remove.addEventListener('click', () => {
        documents[name].splice(index, 1);
        renderDocuments(name);
        form.querySelector(`[data-error-for="${name}"]`).textContent = '';
        field(name).removeAttribute('aria-invalid');
        field(name).focus();
      });
      item.append(filename, remove);
      list.append(item);
    });
  }

  function clearDocuments() {
    Object.keys(documents).forEach((name) => {
      documents[name] = [];
      field(name).value = '';
      field(name).removeAttribute('aria-invalid');
      form.querySelector(`[data-error-for="${name}"]`).textContent = '';
      renderDocuments(name);
    });
  }

  function selectDocuments(input) {
    const name = input.name;
    const picked = Array.from(input.files);
    input.value = ''; // Keep File objects only in the current form state.
    if (!picked.length) return;
    const config = documentConfig.fields[name];
    const candidates = config.limit === 1 ? picked : [...documents[name], ...picked];
    let message = '';
    if (candidates.length > config.limit) {
      message = config.limit === 1 ? 'You can attach a maximum of 1 NDIS Plan.' : 'You can attach a maximum of 3 supporting reports.';
    } else if (picked.some((file) => {
      const extension = file.name.split('.').pop().toLowerCase();
      const expected = documentConfig.mimeTypes[extension];
      return !expected || (file.type && file.type !== 'application/octet-stream' && file.type !== expected);
    })) {
      message = 'Please upload a PDF, DOC or DOCX file.';
    } else if (picked.some((file) => file.size > documentConfig.maxSizeMB * 1024 * 1024)) {
      message = `Each document must be ${documentConfig.maxSizeMB} MB or smaller.`;
    }
    if (message) {
      setError(name, message);
      return;
    }
    documents[name] = candidates;
    renderDocuments(name);
  }

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
    state.support = state.fixedSupport || selected('support')?.value || '';
    const support = state.support;

    const roleField = form.querySelector('[data-role-field]');
    roleField.hidden = contactFor === 'Myself';
    field('role').required = !roleField.hidden;
    field('role').disabled = roleField.hidden;
    roleOther.hidden = roleField.hidden || value('role') !== 'Other';
    field('roleOther').disabled = roleOther.hidden;
    if (roleField.hidden) {
      ['role', 'roleOther'].forEach((name) => {
        form.querySelector(`[data-error-for="${name}"]`).textContent = '';
        field(name).removeAttribute('aria-invalid');
      });
    }
    field('roleOther').required = !roleOther.hidden;
    personFields.hidden = contactFor !== 'Someone else';
    field('personFirstName').required = !personFields.hidden;
    field('personLastName').required = !personFields.hidden;
    ndisQuestion.hidden = support !== 'ndis';
    documentSection.hidden = support !== 'ndis';
    const disabilityFields = form.querySelector('[data-ndis-disabilities]');
    disabilityFields.hidden = support !== 'ndis';
    ['primaryDisability', 'secondaryDisabilities'].forEach((name) => {
      field(name).disabled = disabilityFields.hidden;
      if (disabilityFields.hidden) field(name).value = '';
    });
    Object.keys(documents).forEach((name) => { field(name).disabled = documentSection.hidden; });
    if (documentSection.hidden) {
      clearDocuments();
      review.replaceChildren();
    }
    form.querySelector('[data-plan-document-note]').hidden = support !== 'ndis' || selected('ndisPlan')?.value !== 'Yes';
    privateNote.hidden = Boolean(state.fixedSupport) || support !== 'private';
    childNote.hidden = Boolean(state.fixedSupport) || support !== 'child-safety';
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
      const isInvalidEmail = control.type === 'email' && !validateEmailAddress(control.value.trim(), control);
      const isInvalidPhone = control.type === 'tel' && !validateAustralianPhone(control.value.trim());

      if (!control.validity.valid || isInvalidEmail || isInvalidPhone) {
        let message = `Please enter your ${control.labels?.[0]?.textContent.toLowerCase() || 'information'}.`;
        if (control.type === 'email') message = 'Please enter a valid email address, for example name@example.com.';
        if (control.type === 'tel') message = 'Please enter a valid Australian mobile or landline number.';
        setError(control.name, message);
        firstInvalid ||= control;
      }
    });

    if (stepNumber === finalStep && !field('consent').checked) {
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

  function showStep(stepNumber, { manageFocus = true, scroll = true } = {}) {
    if (stepNumber < 1 || stepNumber > finalStep) return;

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
    nextButton.hidden = stepNumber === finalStep;
    submitButton.hidden = stepNumber !== finalStep;
    status.hidden = true;
    if (stepNumber === finalStep) renderReview();
    if (manageFocus) steps[stepNumber - 1].querySelector('h2').focus({ preventScroll: true });
    if (scroll) document.querySelector('.intake__surface').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      ['Contacting for', contactFor], ['Role', contactFor === 'Myself' ? '' : (value('role') === 'Other' ? value('roleOther') : value('role'))],
      ['Name', `${value('firstName')} ${value('lastName')}`], ['Email', value('email')], ['Phone', value('phone')]
    ]);
    addReviewGroup('Support', 2, [['Support pathway', supportLabels[state.support]], ['NDIS plan', state.support === 'ndis' ? selected('ndisPlan')?.value : '']]);
    if (state.support === 'ndis' && Object.values(documents).some((files) => files.length)) {
      addReviewGroup('Supporting documents', 4, Object.entries(documents).flatMap(([name, files]) =>
        files.map((file) => [documentConfig.fields[name].label, file.name])));
    }
    addReviewGroup('About the person', 3, [['Person being referred', contactFor === 'Someone else' ? `${value('personFirstName')} ${value('personLastName')}` : 'Myself'],
      ['Primary Disability', state.support === 'ndis' ? value('primaryDisability') : ''],
      ['Secondary Disability or disabilities', state.support === 'ndis' ? value('secondaryDisabilities') : ''],
      ['Age range', selected('ageRange')?.value]]);
    addReviewGroup('Your message', 4, [['Preferred contact', selected('preferredContact')?.value], ['Best time', value('contactTime') === 'Other' ? value('contactTimeOther') : value('contactTime')], ['Message', value('message')]]);
  }

  function applyUrlContext() {
    const parameters = new URLSearchParams(window.location.search);
    const support = parameters.get('support');
    const intent = parameters.get('intent');
    const pathways = {
      ndis: {
        label: 'NDIS Support',
        heading: "Let's get your support started.",
        introduction: "You're enquiring about NDIS Support with Pure Coaching. We'll ask a few quick questions so we can understand what you're looking for and help with the next steps."
      },
      private: {
        label: 'Private Support',
        heading: "Let's find the right support for you.",
        introduction: "You're enquiring about Private Support with Pure Coaching. No NDIS plan is required — we'll ask a few questions about what you're looking for."
      },
      'child-safety': {
        label: 'Child Safety',
        heading: 'Tell us how we can help.',
        introduction: "You're making a Child Safety enquiry. We'll collect a few details so our team can understand what you're looking for and get in touch."
      }
    };
    const allowedIntent = ['enquiry', 'enrolment', 'referral', 'general'];
    state.fixedSupport = Object.hasOwn(pathways, support) ? support : '';
    state.support = state.fixedSupport;
    state.intent = allowedIntent.includes(intent) ? intent : '';
    if (state.fixedSupport === 'ndis' && state.intent === 'enquiry') {
      form.querySelector('#message-help').textContent = "Tell us a little about your situation and what you'd like help with. Don't worry if you're not sure what support you need yet — just tell us what you know.";
    }
    const choices = form.querySelector('[data-required-group="support"]');
    choices.hidden = Boolean(state.fixedSupport);
    choices.disabled = Boolean(state.fixedSupport);
    if (state.fixedSupport) {
      const pathway = pathways[state.fixedSupport];
      const eyebrow = form.querySelector('[data-support-eyebrow]');
      const introduction = form.querySelector('[data-support-introduction]');
      eyebrow.textContent = pathway.label;
      eyebrow.hidden = false;
      form.querySelector('#form-step-2-title').textContent = pathway.heading;
      introduction.textContent = pathway.introduction;
      introduction.hidden = false;
      context.textContent = pathway.label + ' enquiry';
      context.hidden = false;
    }
    if (state.intent === 'referral') form.querySelector('input[name="contactFor"][value="Someone else"]').checked = true;
    if (state.intent === 'enrolment') form.querySelector('input[name="contactFor"][value="Myself"]').checked = true;
    updateConditionals();
  }

  nextButton.addEventListener('click', () => {
    if (state.step < finalStep && validateStep(state.step)) showStep(state.step + 1);
  });
  backButton.addEventListener('click', () => {
    if (state.step > 1) showStep(state.step - 1);
  });
  form.addEventListener('change', (event) => {
    updateConditionals();
    const error = form.querySelector(`[data-error-for="${event.target.name}"]`);
    if (error) error.textContent = '';
    event.target.removeAttribute('aria-invalid');
    if (Object.hasOwn(documents, event.target.name) && !documentSection.hidden) selectDocuments(event.target);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!validateStep(finalStep)) return;
    // Development preview only: no enquiry or documents are transmitted.
    clearDocuments();
    review.replaceChildren();
    form.hidden = true;
    document.querySelector('.intake-progress').hidden = true;
    context.hidden = true;
    confirmation.hidden = false;
    confirmation.focus();
  });

  steps.forEach((step) => step.querySelector('h2').setAttribute('tabindex', '-1'));
  applyUrlContext();
  showStep(1, { manageFocus: false, scroll: false });
}

initIntakeForm();
