import React from 'react';
import ReactDOM from 'react-dom';

function LoginModal({ children }) {
    return ReactDOM.createPortal(
        <div className="modal">
            {children}
        </div>,
        document.getElementById('modal-root') // Targeting the DOM node
    );
}
export default LoginModal;
