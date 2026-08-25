'use strict';

const DESIGN_SYSTEM = Object.freeze({
  MUI: 'MUI',
  ANT_DESIGN: 'ANT_DESIGN',
  SHADCN_RADIX: 'SHADCN_RADIX',
  SALESFORCE_LIGHTNING: 'SALESFORCE_LIGHTNING',
  SAP_UI5: 'SAP_UI5',
  BOOTSTRAP: 'BOOTSTRAP',
  HEADLESS_UI: 'HEADLESS_UI',
  PRIMEREACT: 'PRIMEREACT',
  KENDO_UI: 'KENDO_UI',
  ANGULAR_MATERIAL: 'ANGULAR_MATERIAL',
  GENERIC: 'GENERIC',
});

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function detectDesignSystemSignature(identity = {}, resolution = {}) {
  const tagName = String(identity.tagName || resolution.target?.tagName || '').toUpperCase();
  const role = clean(identity.role || resolution.target?.role).toLowerCase();
  const className = clean(identity.className || identity.classes || resolution.target?.className);
  const attributes = identity.attributes || resolution.target?.attributes || {};
  const controlType = clean(identity.controlType || resolution.target?.controlType).toLowerCase();

  // 1. Material-UI (MUI)
  if (/Mui[A-Z]/.test(className) || attributes['data-mui-test'] || /MuiSelect|MuiAutocomplete|MuiButton|MuiInput|MuiDatePicker/.test(className)) {
    if (/MuiSelect/.test(className) || role === 'combobox') {
      return {
        designSystem: DESIGN_SYSTEM.MUI,
        componentKind: 'Select',
        adapterKind: 'CUSTOM_SELECT',
        optionItemSelector: '.MuiMenuItem-root, [role="option"]',
        popupSelector: '.MuiMenu-paper, .MuiPopover-paper, [role="listbox"]',
      };
    }
    if (/MuiAutocomplete/.test(className) || /autocomplete/.test(controlType)) {
      return {
        designSystem: DESIGN_SYSTEM.MUI,
        componentKind: 'Autocomplete',
        adapterKind: 'AUTOCOMPLETE',
        optionItemSelector: '.MuiAutocomplete-option, [role="option"]',
        popupSelector: '.MuiAutocomplete-popper, [role="listbox"]',
      };
    }
    if (/MuiDatePicker|MuiPickers/.test(className)) {
      return {
        designSystem: DESIGN_SYSTEM.MUI,
        componentKind: 'DatePicker',
        adapterKind: 'DATE',
        popupSelector: '.MuiPickersPopper-root, .MuiCalendarOrClockPicker-root',
      };
    }
    if (/MuiAccordion/.test(className)) {
      return {
        designSystem: DESIGN_SYSTEM.MUI,
        componentKind: 'Accordion',
        adapterKind: 'ACCORDION',
      };
    }
  }

  // 2. Ant Design (AntD)
  if (/ant-/.test(className) || tagName.startsWith('ANT-')) {
    if (/ant-select/.test(className)) {
      return {
        designSystem: DESIGN_SYSTEM.ANT_DESIGN,
        componentKind: 'Select',
        adapterKind: 'CUSTOM_SELECT',
        optionItemSelector: '.ant-select-item-option',
        popupSelector: '.ant-select-dropdown',
      };
    }
    if (/ant-picker/.test(className)) {
      return {
        designSystem: DESIGN_SYSTEM.ANT_DESIGN,
        componentKind: 'DatePicker',
        adapterKind: 'DATE',
        popupSelector: '.ant-picker-dropdown',
      };
    }
    if (/ant-tree-select|ant-cascader/.test(className)) {
      return {
        designSystem: DESIGN_SYSTEM.ANT_DESIGN,
        componentKind: 'TreeSelect',
        adapterKind: 'AUTOCOMPLETE',
        popupSelector: '.ant-select-dropdown, .ant-cascader-dropdown',
      };
    }
  }

  // 3. Shadcn/ui & Radix UI
  if (attributes['data-radix-collection-item'] || attributes['data-radix-popper-content-wrapper'] || attributes['data-state'] || /radix/.test(className)) {
    if (role === 'combobox' || attributes['aria-haspopup'] === 'dialog' || attributes['aria-haspopup'] === 'listbox') {
      return {
        designSystem: DESIGN_SYSTEM.SHADCN_RADIX,
        componentKind: 'SelectOrCombobox',
        adapterKind: 'CUSTOM_SELECT',
        optionItemSelector: '[data-radix-collection-item], [role="option"]',
        popupSelector: '[data-radix-popper-content-wrapper], [role="listbox"]',
      };
    }
  }

  // 4. Salesforce Lightning (LWC / Aura)
  if (tagName.startsWith('LIGHTNING-') || /slds-/.test(className)) {
    if (tagName === 'LIGHTNING-COMBOBOX' || /slds-combobox/.test(className)) {
      return {
        designSystem: DESIGN_SYSTEM.SALESFORCE_LIGHTNING,
        componentKind: 'LightningCombobox',
        adapterKind: 'CUSTOM_SELECT',
        optionItemSelector: '.slds-listbox__option, [role="option"]',
        popupSelector: '.slds-dropdown, [role="listbox"]',
      };
    }
    if (tagName === 'LIGHTNING-INPUT' && attributes.type === 'date') {
      return {
        designSystem: DESIGN_SYSTEM.SALESFORCE_LIGHTNING,
        componentKind: 'LightningDatePicker',
        adapterKind: 'DATE',
      };
    }
  }

  // 5. SAP UI5 / Fiori
  if (/sapM[A-Z]/.test(className) || /sapUi/.test(className)) {
    if (/sapMSelect|sapMComboBox/.test(className)) {
      return {
        designSystem: DESIGN_SYSTEM.SAP_UI5,
        componentKind: 'SapSelect',
        adapterKind: 'CUSTOM_SELECT',
        optionItemSelector: '.sapMSelectListItem, .sapMComboBoxItem',
        popupSelector: '.sapMPopover, [role="listbox"]',
      };
    }
    if (/sapMDatePicker/.test(className)) {
      return {
        designSystem: DESIGN_SYSTEM.SAP_UI5,
        componentKind: 'SapDatePicker',
        adapterKind: 'DATE',
      };
    }
  }

  // 6. Angular Material / MDC
  if (/mat-mdc-|mat-/.test(className) || tagName.startsWith('MAT-')) {
    if (tagName === 'MAT-SELECT' || /mat-select/.test(className)) {
      return {
        designSystem: DESIGN_SYSTEM.ANGULAR_MATERIAL,
        componentKind: 'MatSelect',
        adapterKind: 'CUSTOM_SELECT',
        optionItemSelector: '.mat-mdc-option, mat-option',
        popupSelector: '.mat-mdc-select-panel, .mat-select-panel',
      };
    }
    if (/mat-datepicker/.test(className) || tagName === 'MAT-DATEPICKER') {
      return {
        designSystem: DESIGN_SYSTEM.ANGULAR_MATERIAL,
        componentKind: 'MatDatePicker',
        adapterKind: 'DATE',
        popupSelector: '.mat-datepicker-popup',
      };
    }
  }

  // 7. PrimeReact & Kendo UI
  if (/p-dropdown|p-autocomplete|p-calendar/.test(className)) {
    if (/p-dropdown/.test(className)) {
      return {
        designSystem: DESIGN_SYSTEM.PRIMEREACT,
        componentKind: 'PrimeDropdown',
        adapterKind: 'CUSTOM_SELECT',
        optionItemSelector: '.p-dropdown-item',
        popupSelector: '.p-dropdown-panel',
      };
    }
    if (/p-calendar/.test(className)) {
      return {
        designSystem: DESIGN_SYSTEM.PRIMEREACT,
        componentKind: 'PrimeCalendar',
        adapterKind: 'DATE',
        popupSelector: '.p-datepicker',
      };
    }
  }

  if (/k-dropdown|k-combobox|k-datepicker/.test(className)) {
    if (/k-dropdown|k-combobox/.test(className)) {
      return {
        designSystem: DESIGN_SYSTEM.KENDO_UI,
        componentKind: 'KendoDropdown',
        adapterKind: 'CUSTOM_SELECT',
        optionItemSelector: '.k-list-item',
        popupSelector: '.k-popup',
      };
    }
  }

  return {
    designSystem: DESIGN_SYSTEM.GENERIC,
    componentKind: 'Generic',
    adapterKind: null,
  };
}

module.exports = {
  DESIGN_SYSTEM,
  detectDesignSystemSignature,
};
