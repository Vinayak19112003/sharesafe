import { createRoot } from 'react-dom/client';
import { DemoEditor } from './components/DemoEditor';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('The ShareSafe demo mount is missing.');
createRoot(root).render(<DemoEditor />);
