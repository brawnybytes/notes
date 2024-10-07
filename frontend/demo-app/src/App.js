import './App.css';
import LoginModal from './LoginModal';

function App() {
  return (
    <div>
      <h1 data-test-id="data-main-heading">Main App</h1>

      <LoginModal>
        <h2>This is a portal modal</h2>
      </LoginModal>
    </div>
  );
}

export default App;
