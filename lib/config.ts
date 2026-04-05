import Constants from 'expo-constants';
import { Platform } from 'react-native';

const getDevProxyBase = () => {
	if (Platform.OS === 'web') return 'http://localhost:3001/api';
	const hostUri = Constants.expoConfig?.hostUri || (Constants as any).manifest?.debuggerHost;
	if (hostUri) {
		const hostname = hostUri.split(':')[0];
		return `http://${hostname}:3001/api`;
	}
	return 'http://localhost:3001/api';
};

const DEV_PROXY = getDevProxyBase();
const PROD_PROXY = 'https://fabulous-amazement-production.up.railway.app/api';

// Always use production API
export const API_BASE = PROD_PROXY;
