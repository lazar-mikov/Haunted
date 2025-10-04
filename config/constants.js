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
  }
};

export const ALEXA_REGION = 'https://api.eu.amazonalexa.com/v3/events';