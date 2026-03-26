export const SENSOR_CONFIG = {
  'haunted-off': {
    endpointId: 'haunted-off-sensor',
    friendlyName: 'Haunted off',
    description: 'Contact sensor for blackout effect - turns lights off'
  },
  'haunted-on': {
    endpointId: 'haunted-on-sensor',
    friendlyName: 'Haunted on',
    description: 'Contact sensor for lights on effect - turns lights on'
  },
  'flash-red': {
    endpointId: 'haunted-flash-red-sensor',
    friendlyName: 'Flash red',
    description: 'Contact sensor for red flash effect - sets lights to red'
  },
  'ghost-yes': {
    endpointId: 'haunted-yes-sensor',
    friendlyName: 'Ghost Yes',
    description: 'Contact sensor for yes answer - flickers once'
  },
  'ghost-no': {
    endpointId: 'haunted-no-sensor',
    friendlyName: 'Ghost No',
    description: 'Contact sensor for no answer - flickers twice'
  }
};

export const ALEXA_REGION = 'https://api.eu.amazonalexa.com/v3/events';